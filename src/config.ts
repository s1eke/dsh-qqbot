/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

/** 附件发送配置（qqbot_send_file 工具与 present 交付物投递共用） */
export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
  /** 是否把 present 声明的交付文件在轮末发送到当前会话 */
  sendPresentedFiles: boolean;
  /** 单轮最多投递的交付文件数 */
  maxFiles: number;
}

/**
 * 非 QQ 读者输入（如桌面端续聊 QQ 会话）的回合是否主动推送到 QQ。
 * - off：不推送，回复只留在发起的界面；
 * - c2c：只推送私聊会话（默认，避免桌面上的私人操作出现在群里）；
 * - all：私聊和群聊都推送。
 */
export type ExternalTurnDelivery = 'off' | 'c2c' | 'all';

/** 主动推送策略（定时任务等服务回合始终主动推送） */
export interface ProactiveDeliveryConfig {
  externalTurns: ExternalTurnDelivery;
}

export interface ConversationConfig {
  mode: 'serial' | 'interactive';
  /** 从收到消息到接入宿主的截止时间，包括队列与附件准备。 */
  admissionTimeoutMs: number;
  maxPendingInputs: number;
  maxPendingBytes: number;
  /** 绑定确切 turn / activation；0 表示不设置运行期限。 */
  mainTimeoutMs: number;
  taskTimeoutMs: number;
  /** 群任务管理员 QQ openid；任务发起人始终可以操作自己的任务。 */
  taskAdmins: string[];
}

export const CONVERSATION_DEFAULTS: ConversationConfig = {
  mode: 'serial', admissionTimeoutMs: 30_000,
  maxPendingInputs: 32, maxPendingBytes: 256 * 1024,
  mainTimeoutMs: 30 * 60_000, taskTimeoutMs: 60 * 60_000, taskAdmins: [],
};

export function conversationConfig(config: Pick<ImQQBotConfig, 'conversation'>): ConversationConfig {
  return { ...CONVERSATION_DEFAULTS, ...config.conversation };
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省 ~/.dsh-qqbot/workspace，不随宿主进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收；<=0 表示不回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** serial 模式 SDK 处理期限；不保证取消底层模型调用。 */
  processingTimeoutMs: number;
  /** 新模式显式开启，省略保持串行兼容。 */
  conversation?: ConversationConfig;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具与交付物投递共用） */
  sendFile: SendFileConfig;
  /** 主动推送策略 */
  proactiveDelivery: ProactiveDeliveryConfig;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式（默认开放）'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单（QQ OpenID）'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式（默认开放：群自带进群门槛 + @bot 触发）'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单（群 OpenID）'),
});

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().description('Agent working directory (default ~/.dsh-qqbot/workspace)'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)，<=0 不回收'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('serial 模式 SDK 处理期限(ms)，不保证取消底层执行'),
  conversation: Schema.object({
    mode: Schema.union(['serial', 'interactive']).default('serial').description('对话模式：interactive 可在执行中接收补充'),
    admissionTimeoutMs: Schema.number().min(1).step(1).default(30_000).description('消息接入截止时间(ms)，包括排队与附件准备'),
    maxPendingInputs: Schema.number().min(1).step(1).default(32).description('每会话宿主未领取输入数量上限'),
    maxPendingBytes: Schema.number().min(1).step(1).default(256 * 1024).description('每会话未领取输入 UTF-8 字节上限'),
    mainTimeoutMs: Schema.number().min(0).step(1).default(30 * 60_000).description('主会话每轮运行期限(ms)，0 不限'),
    taskTimeoutMs: Schema.number().min(0).step(1).default(60 * 60_000).description('后台每次 activation 运行期限(ms)，0 不限'),
    taskAdmins: Schema.array(Schema.string()).default([]).description('可操作群内其他用户任务的 QQ openid'),
  }).default(CONVERSATION_DEFAULTS).description('持续对话与后台任务'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
    maxTokens: Schema.number().default(1024).description('输出 token 上限'),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
    sendPresentedFiles: Schema.boolean().default(true).description('是否将 present 声明的交付文件发送到当前会话'),
    maxFiles: Schema.number().default(4).description('单轮最多投递的交付文件数'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
    sendPresentedFiles: true,
    maxFiles: 4,
  }).description('附件发送配置'),
  proactiveDelivery: Schema.object({
    externalTurns: Schema.union(['off', 'c2c', 'all']).default('c2c')
      .description('非 QQ 输入（如桌面续聊）的回合是否推送到 QQ：off=不推送，c2c=仅私聊，all=私聊和群聊'),
  }).default({
    externalTurns: 'c2c',
  }).description('主动推送策略（定时任务等服务回合始终推送）'),
});
