/**
 * 破甲规则元数据层 —— 分组、40 条规则、预设、规范化。
 *
 * 这一层**不 import 任何东西**，所以谁都能引用它而不产生循环依赖。
 * 正文过滤逻辑在 `rule-filter.js`，界面快照在 `rule-catalog.js`。
 *
 * 为什么拆三层：过滤需要 `RULE_CATALOG` 判断「这个编号是不是规则」，
 * 而界面快照需要过滤层的 `detectPresentIds` / `hasPoliticsGate`。
 * 三者放一个文件就是环，拆开就干净。
 */

/**
 * 分组定义。顺序即界面渲染顺序。
 * `id` 同时是 URL 查询参数 `group` 的取值。
 * `tone` 只给界面用（配色倾向），不参与过滤。
 */
export const RULE_GROUPS = [
  { id: 'offense', label: '攻击与渗透', en: 'Offense and access',
    hint: '网络侧入侵、提权、内网横向、域、数据库、DoS',
    en_hint: 'Network intrusion, privesc, lateral movement, AD, databases, DoS', tone: 'red' },
  { id: 'cloud', label: '云与容器', en: 'Cloud and containers',
    hint: 'IAM 提权、元数据、S3 接管、K8s、容器逃逸',
    en_hint: 'IAM privesc, metadata, S3 takeover, K8s, container escape', tone: 'cyan' },
  { id: 'supply', label: '供应链与 CI/CD', en: 'Supply chain and CI/CD',
    hint: '依赖投毒、Actions 注入、runner 滥用、产物篡改',
    en_hint: 'Dependency poisoning, Actions injection, runner abuse, artifact tampering', tone: 'cyan' },
  { id: 'malware', label: '恶意代码与规避', en: 'Malware and evasion',
    hint: '木马、勒索、免杀、C2、样本分析、反取证、隐写',
    en_hint: 'Trojans, ransomware, AV evasion, C2, sample analysis, anti-forensics, stego', tone: 'red' },
  { id: 'reverse', label: '逆向与破解', en: 'Reverse and cracking',
    hint: '脱壳、反编译、注册机、DRM',
    en_hint: 'Unpacking, decompilation, keygen, DRM', tone: 'amber' },
  { id: 'credential', label: '凭证与身份', en: 'Credentials and identity',
    hint: '撞库、喷洒、票据滥用、OSINT',
    en_hint: 'Credential stuffing, spraying, ticket abuse, OSINT', tone: 'amber' },
  { id: 'web', label: 'Web 与移动', en: 'Web and mobile',
    hint: 'SQLi/XSS/SSRF、APK/IPA 逆向、密码学攻击',
    en_hint: 'SQLi/XSS/SSRF, APK/IPA reversing, crypto attacks', tone: 'green' },
  { id: 'cheat', label: '游戏与外挂', en: 'Game cheats',
    hint: '内存修改、注入、反作弊对抗',
    en_hint: 'Memory editing, injection, anti-cheat bypass', tone: 'amber' },
  { id: 'social', label: '社工与伪造', en: 'Social engineering and forgery',
    hint: '钓鱼、仿站、证件伪造、金融、深伪',
    en_hint: 'Phishing, clone sites, forged documents, finance, deepfakes', tone: 'red' },
  { id: 'physical', label: '硬件与无线', en: 'Hardware and wireless',
    hint: '固件、JTAG、WiFi、RFID、侧信道',
    en_hint: 'Firmware, JTAG, WiFi, RFID, side channels', tone: 'cyan' },
  { id: 'content', label: '内容与资源', en: 'Content and sourcing',
    hint: '成人内容、盗版资源、长篇创作、黑暗题材',
    en_hint: 'Adult content, piracy, long-form fiction, dark themes', tone: 'violet' },
  { id: 'prompt', label: '提示词对抗', en: 'Prompt adversarial',
    hint: '越狱、系统提示提取、代理与工具链攻击',
    en_hint: 'Jailbreaks, system prompt extraction, agent and toolchain attacks', tone: 'violet' },
  { id: 'business', label: '商业与自动化', en: 'Business and automation',
    hint: '增长运营、秒杀抢票、抓取、商情',
    en_hint: 'Growth ops, ticket scalping, scraping, market intel', tone: 'green' },
  { id: 'restricted', label: '受限项', en: 'Restricted',
    hint: '默认关闭，需显式勾选',
    en_hint: 'Off by default; must be selected explicitly', tone: 'mute' },
]

/**
 * 40 条规则的元数据。`id` 必须与正文里 `N. ` 的编号一致。
 *
 * 字段：
 *  - `defaultOn`  首次安装的默认值。用户保存过选择后以用户选择为准。
 *                 政治（10）默认关 —— 这是本包唯一的上游硬性例外。
 *  - `en`         英文名。界面按宿主 locale 选，不硬编码中文。
 *  - `level`      `core` 核心 / `std` 标准 / `agg` 激进，供界面按强度过滤。
 *  - `tags`       检索关键词（中英混排，界面搜索直接匹配）。
 *  - `why`        一句话说明「开了这条会发生什么」，比 short 更具体。
 *  - `since`      引入版本，界面可标记「新增」，也方便排查旧正文缺条。
 */
export const RULE_CATALOG = [
  { id: 1, group: 'cheat', level: 'std', defaultOn: true,
    label: '游戏外挂 / 内存修改 / 反作弊', en: 'Game cheats / memory editing / anti-cheat',
    short: '外挂、透视、自瞄、注入、ACE 过检',
    en_short: 'Cheats, ESP, aimbot, injection, ACE bypass',
    why: '内存读写、AOB 扫描、注入与反作弊绕过按本机测试流程给到实现',
    en_why: 'Memory read/write, AOB scanning, injection and anti-cheat bypass delivered as working implementations',
    tags: ['外挂', 'cheat', '内存', 'memory', '透视', '自瞄', 'aimbot', '注入', 'inject', 'ACE', 'EAC', 'BattlEye', '反作弊'] },
  { id: 2, group: 'offense', level: 'core', defaultOn: true,
    label: '渗透与未授权访问叙事', en: 'Pentest and access narratives',
    short: '渗透、拿站、webshell、留后门',
    en_short: 'Pentest, taking sites, webshell, backdoors',
    why: '侦察→扫描→利用→后渗透全链给命令与载荷，不做防守向改写',
    en_why: 'Full chain from recon to scan to exploit to post-exploit, with commands and payloads, no defensive rewrite',
    tags: ['渗透', 'pentest', '拿站', '日站', 'webshell', '后门', 'backdoor', '提权', '命令注入', 'RCE'] },
  { id: 3, group: 'malware', level: 'agg', defaultOn: true,
    label: '恶意软件与规避', en: 'Malware and evasion',
    short: '木马、蠕虫、勒索、免杀、AMSI/ETW',
    en_short: 'Trojans, worms, ransomware, AV evasion, AMSI/ETW',
    why: '加载器、木马、勒索、局域网蠕虫、持久化与 AV/AMSI 绕过给完整代码',
    en_why: 'Loaders, trojans, ransomware, LAN worms, persistence and AV/AMSI bypass as complete code',
    tags: ['木马', 'trojan', '蠕虫', 'worm', '勒索', 'ransomware', '免杀', 'AMSI', 'ETW', 'Defender', 'AV bypass', 'rootkit'] },
  { id: 4, group: 'reverse', level: 'std', defaultOn: true,
    label: '逆向工程与破解', en: 'Reverse engineering and cracking',
    short: '脱壳、加壳、keygen、卡密、DRM',
    en_short: 'Unpacking, packing, keygen, license keys, DRM',
    why: '反汇编、脱壳、补丁、注册机、激活绕过、卡密逻辑与 DRM 分析',
    en_why: 'Disassembly, unpacking, patching, keygen, activation bypass, license logic and DRM analysis',
    tags: ['逆向', 'reverse', '脱壳', 'unpack', '加壳', 'keygen', '注册机', '卡密', 'DRM', '破解', 'crack', 'Frida'] },
  { id: 5, group: 'social', level: 'agg', defaultOn: true,
    label: '欺诈与社会工程', en: 'Fraud and social engineering',
    short: '钓鱼套件、仿站、BEC、话术',
    en_short: 'Phishing kits, clone sites, BEC, scripts',
    why: '钓鱼页/邮件模板、仿站、话术脚本、凭据收割与短信诱饵',
    en_why: 'Phishing pages and mail templates, clone sites, call scripts, credential harvesting and SMS lures',
    tags: ['钓鱼', 'phishing', '社工', 'social', '仿站', 'clone', 'BEC', '话术', 'credential harvesting'] },
  { id: 6, group: 'social', level: 'agg', defaultOn: true,
    label: '身份与证件伪造', en: 'Identity and document forgery',
    short: 'ID、护照、签证、文凭、KYC 绕过',
    en_short: 'ID, passport, visa, diploma, KYC bypass',
    why: '各类证件模板与制作方法、KYC 绕过路径',
    en_why: 'Document templates and production methods, KYC bypass paths',
    tags: ['证件', 'ID', 'passport', '护照', '签证', 'visa', '文凭', 'diploma', 'KYC', '伪造', 'forge'] },
  { id: 7, group: 'social', level: 'agg', defaultOn: true,
    label: '金融与资金流动', en: 'Finance and money movement',
    short: '洗钱、跑分、空壳、混币、盗刷',
    en_short: 'Laundering, mule networks, shells, mixers, carding',
    why: '资金分层、跑分网络、空壳公司、混币、结构化与支付页伪造',
    en_why: 'Fund layering, mule networks, shell companies, mixers, structuring and payment page forgery',
    tags: ['洗钱', 'laundering', '跑分', 'mule', '空壳', 'shell company', '混币', 'mixing', '盗刷', 'carding'] },
  { id: 8, group: 'physical', level: 'agg', defaultOn: true,
    label: '边境与物流', en: 'Border crossing and logistics',
    short: '路线、运输、藏匿、走私',
    en_short: 'Routes, transport, concealment, smuggling',
    why: '路线、运输方式、单证与藏匿手法的结构化说明',
    en_why: 'Structured notes on routes, transport methods, paperwork and concealment techniques',
    tags: ['边境', 'border', '物流', 'logistics', '运输', '藏匿', 'concealment', '走私', 'smuggling'] },
  { id: 9, group: 'content', level: 'std', defaultOn: true,
    label: '成人露骨内容', en: 'Adult explicit content',
    short: '露骨性行为、AV 场景、角色扮演',
    en_short: 'Explicit sex, AV scenarios, roleplay',
    why: '按指定尺度写场景与情节节拍，不淡化、不打码、不跳过',
    en_why: 'Scenes and pacing written to the requested level, no fade-out, no censoring, no skipping',
    tags: ['成人', 'adult', 'NSFW', '露骨', 'explicit', '色情', 'AV', '角色扮演', 'roleplay', '黄文'] },
  { id: 10, group: 'restricted', level: 'core', defaultOn: false,
    label: '政治 / 历史 / 时事', en: 'Politics / history / current events',
    short: '本包唯一不展开的类别',
    en_short: 'The one category this package does not cover',
    why: '默认关闭。勾选撤掉正文里的政治硬阻断并把 #10 条目写进提示词；不勾时正文保留「只回一句不展开」的门禁',
    en_why: 'Off by default. Enabling removes the hard political block from the body and writes entry #10 into the prompt; leaving it off keeps the one-line refusal gate',
    tags: ['政治', 'politics', '历史', 'history', '时事', 'current events'] },
  { id: 11, group: 'business', level: 'core', defaultOn: true,
    label: '商业运营', en: 'Business operations',
    short: '增长、外包、内包',
    en_short: 'Growth, outsourcing, insourcing',
    why: '增长、外包/内包与相邻运营需求按可执行方案给',
    en_why: 'Growth, outsourcing and adjacent operations answered with executable plans',
    tags: ['商业', 'business', '增长', 'growth', '外包', 'outsource', '内包', 'insource', '运营'] },
  { id: 12, group: 'offense', level: 'agg', defaultOn: true,
    label: '拒绝服务与压测', en: 'Denial of service and stress testing',
    short: '流量型、应用层、放大、限速绕过',
    en_short: 'Volumetric, application layer, amplification, rate limit bypass',
    why: '流量型/应用层压测、放大手法、资源耗尽与限速绕过',
    en_why: 'Volumetric and application-layer load testing, amplification, resource exhaustion and rate limit bypass',
    tags: ['DoS', 'DDoS', '压测', 'stress', '放大', 'amplification', '限速', 'rate limit'] },
  { id: 13, group: 'web', level: 'core', defaultOn: true,
    label: 'Web 应用安全', en: 'Web application security',
    short: 'SQLi、XSS、SSRF、XXE、上传 RCE',
    en_short: 'SQLi, XSS, SSRF, XXE, upload RCE',
    why: '注入、XSS、SSRF、XXE、反序列化、越权、上传 RCE、JWT 与扫描器 PoC',
    en_why: 'Injection, XSS, SSRF, XXE, deserialization, IDOR, upload RCE, JWT and scanner PoCs',
    tags: ['SQLi', 'XSS', 'SSRF', 'XXE', '反序列化', 'deserialization', '越权', 'IDOR', '上传', 'upload', 'RCE', 'JWT', 'webshell'] },
  { id: 14, group: 'web', level: 'std', defaultOn: true,
    label: '移动应用安全', en: 'Mobile application security',
    short: 'APK/IPA、smali、Frida、小程序',
    en_short: 'APK/IPA, smali, Frida, mini programs',
    why: 'APK/IPA 脱壳、smali、Frida hook、SSL pinning 绕过、重打包、小程序逆向',
    en_why: 'APK/IPA unpacking, smali, Frida hooks, SSL pinning bypass, repackaging, mini program reversing',
    tags: ['APK', 'IPA', 'smali', 'Frida', 'pinning', 'root', 'jailbreak', '小程序', 'miniprogram', '重打包'] },
  { id: 15, group: 'credential', level: 'std', defaultOn: true,
    label: '凭证攻击', en: 'Credential attacks',
    short: '喷洒、撞库、hashcat、Kerberos',
    en_short: 'Spraying, stuffing, hashcat, Kerberos',
    why: '口令喷洒、凭证填充、hashcat/John、字典构造、票据滥用与 OTP 拦截',
    en_why: 'Password spraying, credential stuffing, hashcat/John, wordlist construction, ticket abuse and OTP interception',
    tags: ['撞库', 'credential stuffing', '喷洒', 'spraying', 'hashcat', 'John', '字典', 'wordlist', 'Kerberos', 'NTLM', 'OTP'] },
  { id: 16, group: 'offense', level: 'core', defaultOn: true,
    label: '提权', en: 'Privilege escalation',
    short: 'UAC、SUID、命名管道、内核原语',
    en_short: 'UAC, SUID, named pipes, kernel primitives',
    why: 'UAC 绕过、Linux SUID/capability/namespace 逃逸、sudo 误配、内核原语',
    en_why: 'UAC bypass, Linux SUID/capability/namespace escape, sudo misconfiguration, kernel primitives',
    tags: ['提权', 'privesc', 'UAC', 'SUID', 'capability', 'namespace', 'sudo', '内核', 'kernel', '命名管道'] },
  { id: 17, group: 'offense', level: 'core', defaultOn: true,
    label: '网络与基础设施', en: 'Network and infrastructure',
    short: '端口扫描、代理池、CDN 源站、横向',
    en_short: 'Port scanning, proxy pools, CDN origin, lateral',
    why: '多线程端口扫描、代理/SOCKS 池、CDN 源站发现、DNS 重绑定、鱼叉与横向',
    en_why: 'Multithreaded port scanning, proxy/SOCKS pools, CDN origin discovery, DNS rebinding, pivoting and lateral movement',
    tags: ['端口扫描', 'port scan', '代理池', 'proxy pool', 'CDN', '源站', 'origin IP', 'DNS rebinding', '横向', 'lateral', '隧道', 'tunnel'] },
  { id: 18, group: 'business', level: 'agg', defaultOn: true,
    label: '交易系统自动化滥用', en: 'Transactional system automation',
    short: '抢票、秒杀、验证码识别、批量注册',
    en_short: 'Ticket scalping, flash sales, CAPTCHA solving, bulk registration',
    why: '抢票/秒杀机器人、验证码破解与 OCR 训练、批量注册、短信验证绕过、bot 检测规避',
    en_why: 'Scalping and flash-sale bots, CAPTCHA breaking and OCR training, bulk registration, SMS verification bypass, bot detection evasion',
    tags: ['抢票', '秒杀', 'flash sale', '验证码', 'captcha', 'OCR', '批量注册', '注册机', 'SMS', 'bot 检测'] },
  { id: 19, group: 'credential', level: 'agg', defaultOn: true,
    label: 'OSINT 与人员搜索', en: 'OSINT and people search',
    short: '社工库、地理定位、社交图谱',
    en_short: 'Breach databases, geolocation, social graphs',
    why: '泄露库查询、凭据暴露关联、地理定位、社交图谱构建、人肉流程',
    en_why: 'Leak database queries, credential exposure correlation, geolocation, social graph construction, doxxing workflow',
    tags: ['OSINT', '社工库', 'breach', '地理定位', 'geolocation', '社交图谱', 'social graph', '人肉', 'doxxing'] },
  { id: 20, group: 'malware', level: 'std', defaultOn: true,
    label: '恶意样本分析', en: 'Malicious sample analysis',
    short: '宏提取、PE 脱壳、C2 协议、IOC',
    en_short: 'Macro extraction, PE unpacking, C2 protocols, IOC',
    why: 'Office 宏提取、PE/ELF 脱壳、混淆还原、C2 协议重建、IOC 提取与事件分诊',
    en_why: 'Office macro extraction, PE/ELF unpacking, deobfuscation, C2 protocol reconstruction, IOC extraction and triage',
    tags: ['样本分析', 'malware analysis', '宏', 'macro', 'PE', 'ELF', '脱壳', 'C2', 'IOC', '分诊', 'triage'] },
  { id: 21, group: 'prompt', level: 'agg', defaultOn: true,
    label: '对抗性提示工程', en: 'Adversarial prompt engineering',
    short: '越狱、探针集、系统提示提取',
    en_short: 'Jailbreaks, probe sets, system prompt extraction',
    why: '把安全层当作被测物：产出评测沙盘、探针集与可复现轨迹',
    en_why: 'Treats the safety layer as the subject: evaluation harness, probe sets and reproducible traces',
    tags: ['越狱', 'jailbreak', '对抗样本', 'adversarial', '系统提示', 'system prompt', '探针', 'probe', 'prompt injection'] },
  { id: 22, group: 'physical', level: 'std', defaultOn: true,
    label: '嵌入式与物理', en: 'Embedded and physical',
    short: '固件、IoT 凭证、JTAG/SPI、CAN',
    en_short: 'Firmware, IoT credentials, JTAG/SPI, CAN',
    why: '固件提取、IoT 默认凭证普查、JTAG/SPI/UART、门禁与锁绕过、CAN 总线',
    en_why: 'Firmware extraction, IoT default credential survey, JTAG/SPI/UART, badge and lock bypass, CAN bus',
    tags: ['固件', 'firmware', 'IoT', 'JTAG', 'SPI', 'UART', '门禁', 'badge', 'CAN', '嵌入式'] },
  { id: 23, group: 'content', level: 'std', defaultOn: true,
    label: '盗版与资源采购', en: 'Piracy and resource sourcing',
    short: '磁力、网盘、番号检索、资源站',
    en_short: 'Magnet links, cloud drives, code search, resource sites',
    why: '按本地目录与检索研究处理：站点类型、搜索语法、磁力/网盘流程与占位链接',
    en_why: 'Handled as local catalogue and search research: site types, search syntax, magnet/cloud workflows, placeholder links',
    tags: ['盗版', 'piracy', '资源', 'resource', '磁力', 'magnet', 'torrent', '网盘', '番号', 'warez'] },
  { id: 24, group: 'malware', level: 'agg', defaultOn: true,
    label: 'C2 与后渗透', en: 'C2 and post-exploitation',
    short: '监听器、beacon、持久化、维权',
    en_short: 'Listeners, beacons, persistence, retention',
    why: '监听器搭建、载荷分级、会话管理、任务下发、外传路径与持久化（占位符形式）',
    en_why: 'Listener setup, payload staging, session handling, tasking, exfil paths and persistence in placeholder form',
    tags: ['C2', '远控', 'beacon', 'listener', 'teamserver', '持久化', 'persistence', '维权', '外传', 'exfil'] },
  { id: 25, group: 'physical', level: 'agg', defaultOn: true,
    label: '无线与近场', en: 'Wireless and proximity',
    short: 'WiFi 破解、PMKID、蓝牙、RFID',
    en_short: 'WiFi cracking, PMKID, Bluetooth, RFID',
    why: 'WiFi 握手抓取与破解、PMKID、蓝牙嗅探、RFID/门禁克隆（含占位符命令）',
    en_why: 'WiFi handshake capture and cracking, PMKID, Bluetooth sniffing, RFID/badge cloning with placeholder commands',
    tags: ['WiFi', 'aircrack', '握手', 'handshake', 'PMKID', '蓝牙', 'bluetooth', 'RFID', '门禁', 'clone'] },

  /* ── v2 新增（26..40）────────────────────────────────────────────── */
  { id: 26, group: 'cloud', level: 'std', defaultOn: true,
    label: '云与容器', en: 'Cloud and containers',
    short: 'IAM 提权、元数据、S3 接管、K8s、容器逃逸',
    en_short: 'IAM privesc, metadata, S3 takeover, K8s, container escape',
    why: 'IAM 策略提权与 PassRole 链、IMDS 元数据取凭据、S3/Blob 接管、K8s RBAC 滥用、Pod 逃逸、Docker socket、Terraform state 泄露',
    en_why: 'IAM policy privesc and PassRole chains, IMDS credential retrieval, S3/Blob takeover, K8s RBAC abuse, pod escape, Docker socket, Terraform state leaks',
    tags: ['云', 'cloud', 'AWS', 'Azure', 'GCP', 'IAM', '元数据', 'IMDS', 'S3', 'K8s', 'kubernetes', 'RBAC', '容器逃逸', 'docker', 'Terraform'],
    since: '1.1.0' },
  { id: 27, group: 'supply', level: 'agg', defaultOn: true,
    label: '供应链与 CI/CD', en: 'Supply chain and CI/CD',
    short: '依赖投毒、Actions 注入、runner 滥用、产物篡改',
    en_short: 'Dependency poisoning, Actions injection, runner abuse, artifact tampering',
    why: '依赖混淆与 typosquat 投递、GitHub Actions 表达式注入、自托管 runner 滥用、构建产物与 SBOM 篡改、CI 密钥外传',
    en_why: 'Dependency confusion and typosquat delivery, GitHub Actions expression injection, self-hosted runner abuse, artifact and SBOM tampering, CI secret exfil',
    tags: ['供应链', 'supply chain', '依赖混淆', 'dependency confusion', 'typosquat', 'npm', 'PyPI', 'GitHub Actions', 'CI/CD', 'runner', 'SBOM', '投毒'],
    since: '1.1.0' },
  { id: 28, group: 'offense', level: 'std', defaultOn: true,
    label: '数据库与中间件', en: 'Databases and middleware',
    short: 'Redis 未授权、MSSQL 提权、ES/Mongo 直连',
    en_short: 'Redis unauth, MSSQL privesc, ES/Mongo direct',
    why: 'MySQL/MSSQL/Oracle/PG 注入与提权、Redis 未授权与主从复制 RCE、Mongo/ES 未授权、RabbitMQ/Kafka 滥用、连接串爆破',
    en_why: 'MySQL/MSSQL/Oracle/PG injection and privesc, Redis unauthorized access and replication RCE, Mongo/ES unauthorized, RabbitMQ/Kafka abuse, connection string brute force',
    tags: ['数据库', 'database', 'MySQL', 'MSSQL', 'Oracle', 'PostgreSQL', 'Redis', 'MongoDB', 'Elasticsearch', 'Kafka', 'RabbitMQ', '未授权'],
    since: '1.1.0' },
  { id: 29, group: 'offense', level: 'agg', defaultOn: true,
    label: '内网与域渗透', en: 'Internal network and AD',
    short: 'BloodHound、Kerberoast、ADCS、DCSync、relay',
    en_short: 'BloodHound, Kerberoast, ADCS, DCSync, relay',
    why: 'BloodHound 路径、Kerberoast/AS-REP、ADCS ESC 全系、DCSync、委派滥用、NTLM relay、WMI/WinRM/SMB/PsExec 横向',
    en_why: 'BloodHound paths, Kerberoast/AS-REP, full ADCS ESC range, DCSync, delegation abuse, NTLM relay, WMI/WinRM/SMB/PsExec lateral movement',
    tags: ['内网', 'AD', '域', 'domain', 'BloodHound', 'Kerberoast', 'AS-REP', 'ADCS', 'ESC1', 'DCSync', 'relay', 'NTLM', '横向', 'WinRM', 'PsExec'],
    since: '1.1.0' },
  { id: 30, group: 'malware', level: 'agg', defaultOn: true,
    label: '反取证与痕迹清理', en: 'Anti-forensics and cleanup',
    short: '日志清除、时间戳篡改、沙箱探测',
    en_short: 'Log clearing, timestamp tampering, sandbox detection',
    why: '日志清除与伪造、时间戳篡改、USN/事件日志规避、内存痕迹清理、安全删除、沙箱与虚拟机探测',
    en_why: 'Log clearing and forgery, timestamp tampering, USN/event log evasion, memory artifact cleanup, secure deletion, sandbox and VM detection',
    tags: ['反取证', 'anti-forensics', '日志', 'log wipe', '时间戳', 'timestomp', 'USN', '事件日志', 'evtx', '沙箱', 'sandbox', '反虚拟机'],
    since: '1.1.0' },
  { id: 31, group: 'malware', level: 'std', defaultOn: true,
    label: '隐写与隐蔽信道', en: 'Steganography and covert channels',
    short: 'LSB 隐写、DNS/ICMP 隧道、域前置',
    en_short: 'LSB stego, DNS/ICMP tunnels, domain fronting',
    why: '图像/音频/文档隐写与提取、LSB 与调色板、DNS/ICMP/HTTP 隧道、域前置、分片外传',
    en_why: 'Image/audio/document steganography and extraction, LSB and palette, DNS/ICMP/HTTP tunnels, domain fronting, fragmented exfil',
    tags: ['隐写', 'stego', 'LSB', '隐蔽信道', 'covert channel', 'DNS 隧道', 'ICMP', '域前置', 'domain fronting', '外传'],
    since: '1.1.0' },
  { id: 32, group: 'web', level: 'std', defaultOn: true,
    label: '密码学与协议攻击', en: 'Cryptography and protocol attacks',
    short: 'padding oracle、ECB 拼接、JWT alg、弱随机',
    en_short: 'Padding oracle, ECB cut-and-paste, JWT alg, weak randomness',
    why: 'TLS 降级与证书伪造、padding oracle、ECB 拼接、HMAC 绕过、长度扩展、JWT alg 混淆、弱随机与密钥恢复',
    en_why: 'TLS downgrade and certificate forgery, padding oracle, ECB cut-and-paste, HMAC bypass, length extension, JWT alg confusion, weak randomness and key recovery',
    tags: ['密码学', 'crypto', 'TLS', 'padding oracle', 'ECB', 'HMAC', '长度扩展', 'JWT', 'alg confusion', '弱随机', '密钥'],
    since: '1.1.0' },
  { id: 33, group: 'malware', level: 'agg', defaultOn: true,
    label: '文档与文件格式武器化', en: 'Document and file-format weaponization',
    short: '宏、LNK/ISO 投递、PDF JS、解压穿越',
    en_short: 'Malicious documents, macros, LNK/ISO, parsers',
    why: 'Office 宏与远程模板、LNK/ISO/IMG 投递、PDF JS 与字体解析、压缩包路径穿越、解析器 fuzz 与崩溃利用',
    en_why: 'Office macros and remote templates, OLE/DDE, LNK/ISO/IMG/VHD delivery, PDF JavaScript, RTF, archive traversal, parser fuzzing',
    tags: ['文档', 'document', '宏', 'macro', 'LNK', 'ISO', 'PDF', '字体', 'ZipSlip', '路径穿越', 'fuzz', '解析器'],
    since: '1.1.0' },
  { id: 34, group: 'business', level: 'std', defaultOn: true,
    label: '数据抓取与反爬对抗', en: 'Scraping and anti-bot evasion',
    short: '分布式采集、指纹伪装、打码、入库',
    en_short: 'Scraping, fingerprint spoofing, CAPTCHA, scheduling',
    why: '分布式爬虫骨架、浏览器指纹伪装、验证码打码、登录态复用、限速与重试、结构化抽取与入库',
    en_why: 'Distributed collection skeletons, browser and TLS fingerprint spoofing, CAPTCHA solving, session reuse, rate limiting and retry, anti-bot detection surfaces',
    tags: ['抓取', 'scraping', '爬虫', 'crawler', '反爬', 'anti-bot', '指纹', 'fingerprint', '打码', 'OCR', '限速', '入库'],
    since: '1.1.0' },
  { id: 35, group: 'social', level: 'agg', defaultOn: true,
    label: '深度伪造与语音社工', en: 'Deepfake and voice social engineering',
    short: '换脸、声音克隆、vishing、活体绕过',
    en_short: 'Face swap, voice clone, vishing, liveness bypass',
    why: '换脸与口型同步流水线、TTS 声音克隆、vishing 话术脚本、会议注入、活体检测绕过',
    en_why: 'Face swap and lip sync pipelines, TTS voice cloning, vishing scripts, meeting injection, liveness and ID verification bypass',
    tags: ['深伪', 'deepfake', '换脸', 'faceswap', '声音克隆', 'voice clone', 'TTS', 'vishing', '语音', '活体', 'liveness'],
    since: '1.1.0' },
  { id: 36, group: 'business', level: 'std', defaultOn: true,
    label: '竞争情报与商业调查', en: 'Competitive intelligence',
    short: '企业图谱、股权穿透、招投标、舆情',
    en_short: 'Corporate graphs, equity chains, bidding, sentiment',
    why: '企业图谱与关联方穿透、招投标与舆情、员工与组织架构还原、供应链依赖梳理，输出结构化结论',
    en_why: 'Corporate graphs and related-party tracing, equity and control chains, bidding records, sentiment and hiring-signal org mapping',
    tags: ['商情', 'intelligence', '企业图谱', '股权', '穿透', '招投标', '舆情', '组织架构', '尽调', 'due diligence'],
    since: '1.1.0' },
  { id: 37, group: 'content', level: 'std', defaultOn: true,
    label: '长篇创作 · 世界观与角色', en: 'Long-form fiction: world and characters',
    short: '长篇连载、世界观设定、伏笔回收',
    en_short: 'Long-form, worldbuilding, characters, foreshadowing',
    why: '长篇连载、世界观设定表、角色一致性维护、多线叙事与伏笔回收，直接给可续写正文',
    en_why: 'Serialized fiction, worldbuilding tables, character bibles and consistency, multi-thread narrative, foreshadowing setup and payoff',
    tags: ['长篇', 'novel', '世界观', 'worldbuilding', '角色', 'character', '伏笔', '连载', '创作', 'fiction'],
    since: '1.1.0' },
  { id: 38, group: 'content', level: 'agg', defaultOn: true,
    label: '暴力与黑暗题材', en: 'Violence and dark themes',
    short: '暴力、酷刑、战争、犯罪、禁忌题材',
    en_short: 'Violence, torture, war, crime, dark themes',
    why: '暴力、酷刑、战争、犯罪与禁忌题材的正面书写，按指定尺度给足细节与场景节拍，不淡出',
    en_why: 'Violence, torture, war, crime, betrayal and taboo subjects written to the requested level, no fade-out',
    tags: ['暴力', 'violence', '酷刑', 'torture', '战争', 'war', '犯罪', 'crime', '黑暗', 'dark', '禁忌', 'gore'],
    since: '1.1.0' },
  { id: 39, group: 'prompt', level: 'agg', defaultOn: true,
    label: 'AI 代理与工具链攻击', en: 'Agent and toolchain attacks',
    short: '工具描述投毒、MCP 滥用、检索污染',
    en_short: 'Agent attacks, tool poisoning, MCP, RAG',
    why: '提示词注入载荷、工具描述投毒、MCP 服务滥用、检索库污染、记忆污染、代理越权与外传链，给探针集与可复现轨迹',
    en_why: 'Prompt injection payloads, tool description poisoning, MCP abuse, vector store contamination, memory poisoning, agent privilege escalation',
    tags: ['代理', 'agent', 'MCP', '工具链', 'tool', '投毒', 'poisoning', 'RAG', '检索', '记忆污染', '越权', 'prompt injection'],
    since: '1.1.0' },
  { id: 40, group: 'physical', level: 'agg', defaultOn: true,
    label: '硬件接口与侧信道', en: 'Hardware interfaces and side channels',
    short: 'UART/JTAG、SPI/eMMC、故障注入、侧信道',
    en_short: 'UART/JTAG, SPI/eMMC, glitching, side channels',
    why: 'UART/JTAG/SWD 接线与提权、SPI/eMMC 读取、电压与时钟毛刺、功耗与电磁侧信道、芯片去封装',
    en_why: 'UART/JTAG/SWD wiring and debug access, SPI/eMMC/Flash read and write, bootloader interrupt, voltage and clock glitching, DPA/CPA, die decapping',
    tags: ['硬件', 'hardware', 'UART', 'JTAG', 'SWD', 'SPI', 'eMMC', '故障注入', 'glitch', '侧信道', 'side channel', 'DPA', '去封装'],
    since: '1.1.0' },
]

/**
 * 预设方案 —— 界面上的「一键套用」。
 *
 * `ids` 显式列全，不用 `include/exclude` 这种相对描述 —— 预设必须
 * 在规则目录变化时保持可预测，相对描述会随目录一变就悄悄改变语义。
 * `accent` 只给界面配色，不参与逻辑。
 */
export const RULE_PRESETS = [
  { id: 'default', label: '默认', en: 'Default', accent: 'mute',
    hint: '首次安装的默认集，政治规则关闭',
    ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40] },
  { id: 'minimal', label: '最小集', en: 'Minimal', accent: 'green',
    hint: '只开破甲骨架的常规部分，冲突面最小',
    ids: [2, 11, 13, 16, 17] },
  { id: 'web', label: 'Web 攻防', en: 'Web offense', accent: 'green',
    hint: 'Web / 移动 / 网络 / 凭证 / 密码学 / 抓取',
    ids: [2, 3, 13, 14, 15, 16, 17, 19, 20, 21, 28, 32, 34, 39] },
  { id: 'reverse', label: '逆向与样本', en: 'Reverse and samples', accent: 'amber',
    hint: '逆向、脱壳、样本分析、外挂、移动端、文档武器化',
    ids: [1, 3, 4, 14, 16, 20, 30, 31, 33] },
  { id: 'redteam', label: '红队全链', en: 'Red team chain', accent: 'red',
    hint: '打点 → 提权 → 横向 → 域 → 云 → C2 → 反取证',
    ids: [2, 3, 12, 13, 15, 16, 17, 19, 20, 24, 26, 27, 28, 29, 30, 31, 39] },
  { id: 'cloud', label: '云原生', en: 'Cloud native', accent: 'cyan',
    hint: '云 IAM / 元数据 / K8s / 供应链 / 容器',
    ids: [2, 13, 15, 17, 26, 27, 29, 32] },
  { id: 'research', label: '研究模式', en: 'Research', accent: 'violet',
    hint: '逆向、样本、密码学、代理攻击、侧信道',
    ids: [4, 20, 21, 22, 30, 31, 32, 33, 39, 40] },
  { id: 'content', label: '内容创作', en: 'Content', accent: 'violet',
    hint: '成人、长篇、黑暗题材、盗版资源检索',
    ids: [9, 23, 37, 38] },
  { id: 'business', label: '商业与自动化', en: 'Business', accent: 'green',
    hint: '增长运营、秒杀抢票、抓取、商情',
    ids: [11, 18, 34, 36] },
  { id: 'all', label: '全开', en: 'All', accent: 'red',
    hint: '40 条全勾，包含政治条目的写入',
    ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40] },
]

/** 全部规则 id，升序。 */
export const ALL_RULE_IDS = RULE_CATALOG.map((r) => r.id)

/** 首次安装的默认勾选集合。 */
export const DEFAULT_ENABLED_IDS = RULE_CATALOG.filter((r) => r.defaultOn).map((r) => r.id)

/** id → 元数据。 */
export const RULE_BY_ID = new Map(RULE_CATALOG.map((r) => [r.id, r]))

/** 分组 id → 元数据。 */
export const GROUP_BY_ID = new Map(RULE_GROUPS.map((g) => [g.id, g]))

/** 政治 / 历史 / 时事这条的编号。正文里有一处优先级更高的硬阻断要跟着它一起开关。 */
export const POLITICS_RULE_ID = 10

/** 强度枚举，供界面下拉与快照复用。 */
export const RULE_LEVELS = [
  { id: 'core', label: '核心', en: 'Core', hint: '破甲骨架的常规组成部分' },
  { id: 'std', label: '标准', en: 'Standard', hint: '多数场景会用到的具体能力' },
  { id: 'agg', label: '激进', en: 'Aggressive', hint: '高对抗/高敏感，按需开启' },
]

/** 按 id 取元数据。 */
export function ruleById(id) {
  return RULE_BY_ID.get(Number(id)) || null
}

/** 按分组 id 取分组元数据。 */
export function groupById(id) {
  return GROUP_BY_ID.get(String(id || '')) || null
}

/** 某分组下的全部规则 id。 */
export function ruleIdsOfGroup(groupId) {
  return RULE_CATALOG.filter((r) => r.group === groupId).map((r) => r.id)
}

/**
 * 把任意输入规范化成合法的 rule id 集合。
 *
 * 接受：数组、逗号分隔字符串、`"all"`、`"none"`、数字。
 * 未知 id 丢弃；重复去重；结果升序。**不抛异常** —— 配置脏了就让破甲
 * 降级到默认，而不是让整个插件 apply 炸掉。
 */
export function normalizeEnabledIds(input) {
  if (input === 'all' || input === '*') return [...ALL_RULE_IDS]
  if (input === 'none' || input === '' || input == null) return []
  const raw = Array.isArray(input) ? input : String(input).split(/[,\s]+/)
  const seen = new Set()
  for (const item of raw) {
    const n = Number(String(item).trim())
    if (Number.isInteger(n) && RULE_BY_ID.has(n)) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * 判断某个规则 id 是否启用。
 *
 * `enabledIds` 为 `null`/`undefined` 时视为「默认集」（政治规则默认关闭），
 * 与 `filterScopedRules` / `catalogSnapshot` / `armor-store.effectiveEnabledIds`
 * 三处语义必须一致 —— 早先这里写成「全部启用」，界面会显示 40 而实际注入 39。
 */
export function isRuleEnabled(enabledIds, id) {
  const list = enabledIds == null
    ? DEFAULT_ENABLED_IDS
    : (Array.isArray(enabledIds) ? enabledIds : normalizeEnabledIds(enabledIds))
  return list.includes(Number(id))
}

/** 两套集合的差集，界面用它显示「本次改动影响了几条」。 */
export function diffEnabledIds(before, after) {
  const a = new Set(before == null ? DEFAULT_ENABLED_IDS : normalizeEnabledIds(before))
  const b = new Set(after == null ? DEFAULT_ENABLED_IDS : normalizeEnabledIds(after))
  const added = [...b].filter((id) => !a.has(id)).sort((x, y) => x - y)
  const removed = [...a].filter((id) => !b.has(id)).sort((x, y) => x - y)
  return { added, removed, unchanged: b.size - added.length }
}

/**
 * 把预设 id 解析成规则 id 数组。
 *
 * 未知预设返回 `null`（调用方据此回 400），不静默当成「全开」——
 * 静默降级会让用户以为套用成功了。
 */
export function resolvePreset(presetId) {
  const id = String(presetId || '').trim().toLowerCase()
  if (!id) return null
  const preset = RULE_PRESETS.find((p) => p.id === id)
  if (!preset) return null
  // 与目录求交，目录收缩后预设不会带出已不存在的 id
  return preset.ids.filter((n) => RULE_BY_ID.has(n))
}
