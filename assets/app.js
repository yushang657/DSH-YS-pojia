(function () {
  var KEY = 'ysn-lang';
  var lang = 'zh';
  try { if (localStorage.getItem(KEY) === 'en') lang = 'en'; } catch (e) {}

  /* ---- 尽早给 <html> 打标记，避免英文用户首屏闪一下中文 ---- */
  if (lang === 'en') document.documentElement.className = 'lang-en';

  /* ---- 站点公共文案字典（导航 / 面包屑 / 页脚）---- */
  var NAV_EN = {
    home: 'Home', source: 'Injector', codex: 'Codex', trae: 'Trae',
    workbuddy: 'WorkBuddy', dsh: 'DSH Plugin', install: 'Install',
    changelog: 'Changelog', faq: 'FAQ'
  };
  var FILE_EN = {
    'index.html': 'Home', 'source.html': 'Injector', 'codex.html': 'Codex',
    'trae.html': 'Trae', 'workbuddy.html': 'WorkBuddy', 'dsh-plugin.html': 'DSH Plugin',
    'install.html': 'Install', 'changelog.html': 'Changelog', 'faq.html': 'FAQ'
  };
  var TEXT_EN = [
    ['仅供授权安全研究使用', 'For authorized security research only'],
    ['注入器与载荷', 'injector & payloads'],
    ['返回首页', 'Home'],
    ['安装说明', 'Installation'],
    ['常见问题', 'FAQ'],
    ['更新记录', 'Changelog'],
    ['三层架构', 'Architecture'],
    ['DSH 插件', 'DSH Plugin'],
    ['首页', 'Home'],
    ['项目', 'Projects'],
    ['文档', 'Docs']
  ];

  function isEn() { return lang === 'en'; }

  /* ---- 1. 导航：按 data-nav 或 href 文件名替换，中英双向可逆 ---- */
  function translateNav() {
    var links = document.querySelectorAll('nav.top a');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('data-zh') === null) {
        a.setAttribute('data-zh', a.textContent.replace(/\s+/g, ' ').trim());
      }
      var key = a.getAttribute('data-nav');
      var file = (a.getAttribute('href') || '').split('/').pop();
      var en = NAV_EN[key] || FILE_EN[file];
      if (!en) continue;
      a.textContent = isEn() ? en : a.getAttribute('data-zh');
    }
  }

  /* ---- 2. 标题：<h2>中文 <span class="en">English</span></h2>
         英文模式下中文会残留，这里把中文包进 .zh-only 交给 CSS 接管 ---- */
  function wrapHeadingZh() {
    var hs = document.querySelectorAll('h1,h2,h3');
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i], en = h.querySelector('.en');
      if (!en || h.querySelector('.zh-only')) continue;
      var buf = '', texts = [];
      for (var n = h.firstChild; n && n !== en; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue.replace(/\s+/g, '')) {
          buf += n.nodeValue; texts.push(n);
        }
      }
      if (!buf.replace(/\s+/g, '')) continue;
      for (var k = 0; k < texts.length; k++) h.removeChild(texts[k]);
      var span = document.createElement('span');
      span.className = 'zh-only';
      span.textContent = buf.replace(/\s+$/, '');
      h.insertBefore(span, en);
    }
  }

  /* ---- 3. 面包屑 / 页脚：只替换固定词组，其余保持原样 ---- */
  function translateChromeText() {
    var roots = document.querySelectorAll('.breadcrumb,footer');
    for (var i = 0; i < roots.length; i++) {
      var walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.__zh) node.__zh = node.nodeValue;
        var out = node.__zh;
        if (isEn()) {
          for (var j = 0; j < TEXT_EN.length; j++) out = out.split(TEXT_EN[j][0]).join(TEXT_EN[j][1]);
        }
        node.nodeValue = out;
      }
    }
  }

  /* ---- 4. 按钮文案：语言按钮 + 复制按钮 ---- */
  function translateButtons() {
    var btn = document.getElementById('langBtn');
    if (btn) {
      btn.textContent = isEn() ? '中' : 'EN';
      btn.setAttribute('aria-label', isEn() ? '切换到中文' : 'Switch to English');
      btn.setAttribute('aria-pressed', isEn() ? 'true' : 'false');
    }
    var copies = document.querySelectorAll('.copy');
    for (var i = 0; i < copies.length; i++) {
      if (!copies[i].classList.contains('done')) {
        copies[i].textContent = isEn() ? 'Copy' : '复制';
      }
    }
  }

  function apply() {
    document.documentElement.setAttribute('lang', isEn() ? 'en' : 'zh-CN');
    if (isEn()) document.documentElement.classList.add('lang-en');
    else document.documentElement.classList.remove('lang-en');
    if (document.body) document.body.classList.toggle('lang-en', isEn());
    translateNav();
    translateChromeText();
    translateButtons();
  }

  document.addEventListener('DOMContentLoaded', function () {
    /* 标题包裹要在首次渲染前完成，先跑一次 */
    wrapHeadingZh();
    apply();
    var btn = document.getElementById('langBtn');
    if (btn) btn.addEventListener('click', function () {
      lang = isEn() ? 'zh' : 'en';
      try { localStorage.setItem(KEY, lang); } catch (e) {}
      apply();
    });

    /* 当前栏目高亮：优先 data-nav，其次匹配文件名 */
    var navKey = document.body.getAttribute('data-nav') || '';
    var links = document.querySelectorAll('nav.top a');
    for (var i = 0; i < links.length; i++) links[i].classList.remove('active');
    var act = navKey ? document.querySelector('nav.top a[data-nav="' + navKey + '"]') : null;
    if (act) act.classList.add('active');
    else {
      var here = location.pathname.split('/').pop() || 'index.html';
      for (var j = 0; j < links.length; j++) {
        var href = (links[j].getAttribute('href') || '').split('/').pop();
        if (href === here) links[j].classList.add('active');
      }
    }

    /* 复制按钮：文案随语言切换，不再固定英文 */
    var copies = document.querySelectorAll('.copy');
    for (var c = 0; c < copies.length; c++) {
      copies[c].addEventListener('click', function () {
        var pre = this.parentElement.querySelector('code');
        if (!pre || !navigator.clipboard) return;
        var self = this;
        navigator.clipboard.writeText(pre.textContent).then(function () {
          self.classList.add('done');
          self.textContent = isEn() ? 'Copied' : '已复制';
          setTimeout(function () {
            self.classList.remove('done');
            self.textContent = isEn() ? 'Copy' : '复制';
          }, 1200);
        });
      });
    }
  });
})();
