/** 判定「宿主提示词已清洗」用的标记。desktop.js 生成 WSH 脚本时复用同一份。 */
export const HOST_CLEAN_MARKERS = {
  identity: "[dsh-purge] identity stripped",
  inject: [
    "[dsh-purge] complete prompt keeps waterfall inject",
    "[dsh-purge] complete prompt keeps inject",
    "[dsh-purge] fold-complete inject first",
    // DS-YS 0.2.2-rc.1 实际写出的标记。少了这两个，标记明明在也会判成"没写进宿主"，
    // 于是点应用后永远弹「清洗没有写进全部宿主，已取消重启」。
    "[dsh-purge] every mode keeps system inject",
    "[dsh-purge] complete prompt keeps inject + agent-instructions",
  ],
  drops: [
    "transformed.sections : [completeSection]",
    ": [completeSection]",
  ],
};

/** 重启前看系统提示词文件：标记写上了，或者当前原文里已经没有那两处旧拦截。 */
export function hostPromptKeepsInject(text) {
  const body = String(text || "");
  const identityMarked = body.includes(HOST_CLEAN_MARKERS.identity);
  const injectMarked = HOST_CLEAN_MARKERS.inject.some((m) => body.includes(m));
  if (identityMarked && injectMarked) return true;
  // 空文件或不是这份模块，不能当成已经洗过。
  if (!body.includes("system-prompt/assemble")) return false;
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");
  const dropsInject = HOST_CLEAN_MARKERS.drops.some((m) => body.includes(m));
  return !identityLeft && !dropsInject;
}
