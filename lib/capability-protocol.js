/**
 * 能力选用协议：先读 skill / MCP 目录，再按当前任务选用。
 * 不改官方 skill 注册、不改 MCP 挂载、不 deny 任何工具。
 * 官方 DSH 已写工具用法，这里不另挂 Host tools 纪律。
 */

// [dsh-purge] 不带 `dsh-purge` 前缀:宿主 renderPrompt 内部有一步
// filter(s => s.name.startsWith("dsh-purge")) 把这类段按插入序挪到最前。
// 旧名 "dsh-purge:capabilities" 命中前缀,结果 cap 跑到 inject 前头(dump line 1),
// 反而制造出"cap 在前,inject 在后"的渲染反转。换名绕开这一步过滤。
export const CAPABILITY_SECTION = "dshpg-capabilities";

const OFFICIAL_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first**: Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.
2. **Match the task**: From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task — not “always use something”, not “never use something”.
3. **Call what matches**:
   - Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   - Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool’s semantics.
4. **Only then DIY**: If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.
5. **Subagents / sub-delegates inherit this rule**: Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.
6. Host skills and MCP stay available; this prompt does not remove them.`;

const HACKER_LEAD_PROTOCOL = `## Capability selection by task (小雨 · 指挥)

1. You plan, dispatch with \`subagent\`, verify results, and report. Executors do hands-on work.
2. Before dispatch, know which skills/MCP fit the next stage (from \`<available_skills>\` / hacker skills / session MCP).
3. In every \`subagent\` brief: require the child to **read the skill/MCP catalog, then call only what the assigned task needs** (name concrete skill codes when you know them).
4. Do not ban skill or MCP for children. Leaf limits apply only to further delegation tools (\`subagent_fork\` / workflow / ralph), not to skill/MCP.
5. Vague “go investigate” briefs are wrong; task-matched skill/MCP instructions are right.`;

const HACKER_CHILD_PROTOCOL = `## Capability selection by task (hacker executor)

1. **Read** \`<available_skills>\` / your role skills and available MCP/CLI tools.
2. **Match** them to *your assigned task* (not every skill, not zero skills).
3. **Call** matching skills via \`skill\`, and matching MCP/CLI tools by schema, before freelancing equivalent shell work.
4. DIY only for gaps the catalog does not cover; stay in role; do not re-delegate.`;

const ANDROID_ROOT_PROTOCOL = `## Android 宿主：root 通道

当前宿主是 Android（dsh-go / proot 容器）。**proot 里的 \`uid=0\` 是伪造的**（proot \`-0\` 参数），进程真实身份仍是 App 的 uid。要真 root 必须走 \`su\`。

**唯一正确用法**：\`su -c "<命令>"\`。这个 \`su\` 是转发脚本（\`/usr/local/bin/su\`），把命令送到 Android 侧的 root 桥执行，返回真 root 的输出与退出码。

\`\`\`
su -c "id"                                  # uid=0(root) context=u:r:ksu:s0
su -c "ls /data/data"                       # 读别的应用私有数据
su -c "ps -A -o PID,USER,NAME | head -20"   # 看全部进程
su -c "cat /proc/self/attr/current"         # SELinux 上下文
\`\`\`

**判断是否真 root**：输出里有 \`uid=0\` **且** \`su -c "ls /data/data" | head -1\` 能返回内容。只有前者可能是 proot 假象。

**注意**：
- 每次 \`su -c\` 是一次独立连接，工作目录固定 \`/\`，不保留 \`cd\`、环境变量、shell 函数。要多步就串在一条命令里：\`su -c "cd /data/data/x && ls"\`。
- Android 侧工具（toybox / busybox / nc / curl / unzip / grep / sed / awk / find / sha256sum）在 proot 里**看不到**，必须经 \`su -c\` 调：\`su -c "toybox --version"\`。
- 大输出会被整段回传，别一次 \`cat\` 几十 MB 的文件；先 \`head\` / \`wc -c\` 探大小。
- 写文件时注意属主：经 \`su -c\` 写出来的是 root 属主，App（uid 10417）之后可能读不了。要给 App 用的文件，写完后 \`su -c "chown 10417:10417 <path>"\`。
- root 桥未接通时 \`su -c\` 会报连接失败。先 \`su -c id\` 自检，不通就告诉用户 root 桥没在跑（\`/data/adb/service.d/99-dsh-root-bridge.sh\`），不要假装有 root 硬编结果。`;

/**
 * @param {{ hacker?: boolean, hackerChild?: boolean, enabled?: boolean, android?: boolean }} [opts]
 * @returns {string}
 */
export function capabilityProtocolText(opts = {}) {
  if (opts.enabled === false) return "";
  const base = opts.hackerChild ? HACKER_CHILD_PROTOCOL
    : opts.hacker ? HACKER_LEAD_PROTOCOL
      : OFFICIAL_PROTOCOL;
  /* Android 段落独立追加：四个身份都要知道 root 怎么用，
     否则模型会拿 proot 的假 uid=0 当有 root，写出读不到文件的结果。 */
  return opts.android ? base + "\n\n" + ANDROID_ROOT_PROTOCOL : base;
}
