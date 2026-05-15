window.AppBase = (() => {
  const activePath = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach(a => {
    if(a.getAttribute('href') === activePath) a.classList.add('active');
  });

  const quickSearch = document.querySelector('#global-search');
  if(quickSearch){
    quickSearch.addEventListener('keydown',(e)=>{
      if(e.key==='Enter') location.href = `explore.html?q=${encodeURIComponent(e.target.value.trim())}`;
    });
  }
})();