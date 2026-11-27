(function(){
  var KEY = 'ysn-lang';
  var lang = 'zh';
  try { lang = localStorage.getItem(KEY) || 'zh'; } catch(e) {}
  if (lang !== 'en') lang = 'zh';

  function apply(){
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh');
    document.body.classList.toggle('lang-en', lang === 'en');
    var btn = document.getElementById('langBtn');
    if (btn) {
      btn.textContent = lang === 'zh' ? 'EN' : '中';
      btn.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    apply();
    var btn = document.getElementById('langBtn');
    if (btn) btn.onclick = function(){
      lang = (lang === 'zh') ? 'en' : 'zh';
      try { localStorage.setItem(KEY, lang); } catch(e) {}
      apply();
    };
    // active nav from body data-nav (class added in HTML, this cleans duplicates)
    var navKey = document.body.dataset.nav || '';
    document.querySelectorAll('nav.top a').forEach(function(a){ a.classList.remove('active'); });
    var act = document.querySelector('nav.top a[data-nav="' + navKey + '"]');
    if (act) act.classList.add('active');
    else {
      // fallback: pages without data-nav link, match by href filename
      var here = location.pathname.split('/').pop();
      document.querySelectorAll('nav.top a').forEach(function(a){
        if (a.getAttribute('href') === here || a.getAttribute('href') === '../' + here) a.classList.add('active');
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.copy'), function(b){
      b.onclick = function(){
        var pre = b.parentElement.querySelector('code');
        if (!pre) return;
        navigator.clipboard.writeText(pre.textContent).then(function(){
          var o = b.textContent; b.textContent = 'copied';
          setTimeout(function(){ b.textContent = o; }, 1200);
        });
      };
    });
  });
})();
