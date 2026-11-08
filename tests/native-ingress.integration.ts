import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MockAdapter, textResponse, toolCallResponse } from '@native-test/packages/core/agent-loop/tests/mock-adapter.ts';
import { handleInbound } from '../src/transport/inbound.ts';
import { ConversationActivity } from '../src/transport/activity.ts';
import { QqInputRegistry } from '../src/transport/qq-input-origin.ts';
import { ConfigSchema } from '../src/config.ts';
import type { SessionManager, SessionRecord } from '../src/session/index.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

async function fixture(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new MockAdapter(script);
  ctx.llm.registerAdapter(['mock'], adapter);
  const handle = await ctx.agents.create({ sessionId: SessionId('qq-ingress'), agentOptions:{provider:'mock',model:'mock'} });
  const record = {sessionId:handle.agent.id,agent:handle.agent,generation:0,scope:'c2c',peerId:'reader',replyTarget:{scope:'c2c',targetId:'reader'}} as unknown as SessionRecord;
  const manager = {generation:()=>0,isCurrent:(_s:string,_p:string,g:number)=>g===0,
    findBySessionId:(id:string)=>id===record.sessionId?record:undefined,
    findByAgent:(agent:unknown)=>agent===record.agent?record:undefined,
    getOrCreate:async()=>record} as unknown as SessionManager;
  const config=ConfigSchema({conversation:{mode:'interactive',mainTimeoutMs:0,maxPendingInputs:2}});
  const inputs=new QqInputRegistry();
  const logger={info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()};
  const notify=vi.fn(async()=>{});
  const activity=new ConversationActivity(manager,inputs,config,notify,logger);
  activity.install(ctx);
  const send=(text:string)=>handleInbound({message:{kind:'c2c',senderId:'reader',messageId:text,content:text},state:{},bot:{sendMarkdown:notify}} as unknown as MiddlewareContext,
    manager,config,logger,inputs);
  return {ctx,agent:handle.agent,inputs,adapter,send,notify,async dispose(){activity.dispose();await ctx.fiber.dispose();}};
}

describe('QQ ingress through the real native loop',()=>{
  it('admits two separate corrections during a tool, preserves ordering in the next request, and frees native claims',async()=>{
    const f=await fixture([toolCallResponse('hold','hold',{}),textResponse('已按补充执行')]);
    const entered=Promise.withResolvers<void>(); const release=Promise.withResolvers<void>();
    try{
      f.ctx.tools.register(defineTool({name:'hold',description:'hold one native step',parameters:{},
        output:{schema:{type:'object',properties:{},additionalProperties:false},render:()=>[{type:'text',text:'done'}]},
        async execute(){entered.resolve();await release.promise;return {};}}));
      const committed:string[]=[];
      f.ctx.on('session/event',(_session,event)=>{
        if(event.type==='user/message' && f.inputs.has(event.data.id)) committed.push(event.data.content.map(block=>block.type==='text'?block.text:'').join(''));
      });
      await f.send('开始长任务'); await entered.promise;
      await f.send('补充甲：按项目分组'); await f.send('补充乙：保留来源');
      expect(f.agent.status).toBe('running'); expect(f.agent.inbox.nextStep).toHaveLength(2);
      await f.send('超过限额'); expect(f.notify).toHaveBeenCalledOnce();
      release.resolve();await f.agent.whenIdle();
      const request=JSON.stringify(f.adapter.requests[1]);
      expect(request).toContain('补充甲'); expect(request).toContain('补充乙');
      expect(request.indexOf('补充甲')).toBeLessThan(request.indexOf('补充乙'));
      expect(committed).toEqual(['开始长任务','补充甲：按项目分组','补充乙：保留来源']);
      expect(f.inputs.size).toBe(0);
    }finally{release.resolve();await f.dispose();}
  });
  it('releases a claimed QQ origin rejected before the model request, without claiming it was consumed',async()=>{
    const f=await fixture([]);
    try{
      f.ctx.on('agent/pre-step',async()=>({kind:'reject' as const}),{prepend:true});
      await f.send('被前置规则拒绝');await f.agent.whenIdle();
      expect(f.adapter.requests).toHaveLength(0);
      expect(f.agent.session.snapshotEvents().filter(event=>event.type==='user/message')).toHaveLength(0);
      expect(f.inputs.size).toBe(0);
      expect(f.agent.session.snapshotEvents().at(-1)).toMatchObject({type:'turn/end',data:{reason:{kind:'blocked'}}});
    }finally{await f.dispose();}
  });
});
