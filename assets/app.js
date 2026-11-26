(function(){
  var lang = localStorage.getItem('ysn-lang') || 'zh';
  function apply(){ document.body.classList.toggle('lang-en', lang==='en'); }
  document.addEventListener('DOMContentLoaded', function(){
    apply();
    var btn = document.getElementById('langBtn');
    if(btn){ btn.textContent = lang==='zh' ? 'EN' : '中'; btn.onclick=function(){ lang = lang==='zh'?'en':'zh'; localStorage.setItem('ysn-lang',lang); apply(); btn.textContent = lang==='zh'?'EN':'中'; }; }
    var act = document.querySelector('nav.top a[data-nav="'+ (document.body.dataset.nav||'') +'"]');
    if(act) act.classList.add('active');
    Array.prototype.forEach.call(document.querySelectorAll('.copy'), function(b){
      b.onclick=function(){
        var pre=b.parentElement.querySelector('code');
        if(!pre) return;
        navigator.clipboard.writeText(pre.textContent).then(function(){ var o=b.textContent; b.textContent='copied'; setTimeout(function(){b.textContent=o;},1200); });
      };
    });
  });
})();
