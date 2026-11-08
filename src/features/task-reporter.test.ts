import { describe, expect, it, vi } from 'vitest';
import { TaskReporter } from './task-reporter.ts';
import type { TaskRecord, TaskRegistry } from './task-registry.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import { ConfigSchema } from '../config.ts';

function fixture() {
  const record = { sessionId:'r', scope:'c2c', peerId:'u', generation:0, agent:{id:'r'}, replyTarget:{scope:'c2c',targetId:'u',msgId:'m'} } as SessionRecord;
  const task = {taskId:'t',runId:'run1',rootSessionId:'r',scope:'c2c',peerId:'u',settled:true,state:'completed',name:'worker',title:'资料',local:true,delivery:'unconfirmed',output:'已保存的结果',attempts:[]} as TaskRecord;
  const manager = {findByAgent:(agent: unknown) => agent === record.agent ? record : undefined, holdActivity: vi.fn(() => vi.fn())} as unknown as SessionManager;
  const registry = {get:() => ({...task}),markDelivery:vi.fn((_id:string,_run:string,state:'sent'|'failed')=> {task.delivery=state;})} as unknown as TaskRegistry;
  const sender = {sendMarkdown:vi.fn(async (_target:unknown,_text:string) => {})};
  const files = {deliverWithReceipt:vi.fn(async () => ({sent:1,missed:[] as string[]}))};
  const reporter = new TaskReporter(manager,registry,sender,ConfigSchema({}),files);
  const report = (signal = new AbortController().signal) => reporter.report(record.agent,'t',signal);
  return {record,task,manager,registry,sender,files,report};
}

describe('verified task result delivery', () => {
  it('publishes stored text and files to the fixed peer and coalesces duplicate reports', async () => {
    const h = fixture(); h.task.files=[{path:'/tmp/report.pdf'}];
    await Promise.all([h.report(),h.report()]);
    expect(h.sender.sendMarkdown).toHaveBeenCalledOnce();
    expect(h.sender.sendMarkdown.mock.calls[0]?.[0]).toMatchObject({scope:'c2c',targetId:'u'});
    expect(h.sender.sendMarkdown.mock.calls[0]?.[1]).toContain('已保存的结果');
    expect(h.files.deliverWithReceipt).toHaveBeenCalledOnce();
    expect(h.task.delivery).toBe('sent');
    expect((await h.report()).duplicate).toBe(true);
    expect(h.sender.sendMarkdown).toHaveBeenCalledOnce();
  });
  it('records failed delivery and retries the same result without launching a new activation', async () => {
    const h=fixture(); h.sender.sendMarkdown.mockRejectedValueOnce(new Error('QQ unavailable'));
    await expect(h.report()).rejects.toThrow('QQ unavailable'); expect(h.task.delivery).toBe('failed');
    await h.report(); expect(h.task.delivery).toBe('sent');
    expect(h.registry.markDelivery).toHaveBeenLastCalledWith('t','run1','sent');
  });
  it('keeps partial file delivery failed, with saved file refs available for retry', async () => {
    const h=fixture(); h.task.files=[{path:'/tmp/report.pdf'}];
    h.files.deliverWithReceipt.mockResolvedValueOnce({sent:0,missed:['report.pdf']});
    await expect(h.report()).rejects.toThrow('未送达'); expect(h.task.delivery).toBe('failed');
    expect(h.task.files).toHaveLength(1);
  });
  it('does not mark a send completed after the conversation generation changes', async () => {
    const h=fixture(); let finish!:()=>void;
    h.sender.sendMarkdown.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const sending=h.report(); await Promise.resolve(); h.record.generation=1; finish();
    await expect(sending).rejects.toThrow('closed conversation'); expect(h.task.delivery).toBe('failed');
  });
  it('a pre-aborted attempt cannot poison the retry slot', async () => {
    const h=fixture(); await expect(h.report(AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(h.sender.sendMarkdown).not.toHaveBeenCalled(); await h.report(); expect(h.task.delivery).toBe('sent');
  });
});
