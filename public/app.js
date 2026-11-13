// Página pública: ranking em tempo real (SSE), prêmio, entregas, agenda e regras.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat('pt-BR');
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function nomeMes(aaaamm) { return MESES[Number(aaaamm.slice(5, 7)) - 1] || ''; }
  function mesCurto(aaaamm) { return MESES_CURTOS[Number(aaaamm.slice(5, 7)) - 1] + '/' + aaaamm.slice(0, 4); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function moedasEl(n) {
    var s = el('span', 'moedas', fmt.format(n));
    s.appendChild(el('small', '', 'moedas'));
    return s;
  }

  // ---------- Ranking ----------
  var anterior = null; // id -> moedas, para destacar quem subiu

  function renderRanking(r) {
    if (r.periodo && r.periodo.mes) $('rk-mes').textContent = nomeMes(r.periodo.mes);
    var top = r.top || [];
    var podio = $('podio');
    var lista = $('lista');
    podio.textContent = '';
    lista.textContent = '';
    $('vazio').hidden = top.length > 0;

    var novo = {};
    top.forEach(function (row) {
      var subiu = anterior && (anterior[row.id] === undefined || anterior[row.id] < row.moedas);
      novo[row.id] = row.moedas;
      if (row.posicao <= 3) {
        var card = el('div', 'pod panel p' + row.posicao + (subiu ? ' subiu' : ''));
        card.appendChild(el('div', 'pos', String(row.posicao)));
        if (row.posicao === 1) card.appendChild(el('span', 'coroa', 'Líder'));
        card.appendChild(el('span', 'nome', row.nome));
        card.appendChild(moedasEl(row.moedas));
        podio.appendChild(card);
      } else {
        var li = el('li', subiu ? 'subiu' : '');
        li.appendChild(el('span', 'pos', row.posicao + 'º'));
        li.appendChild(el('span', 'nome', row.nome));
        li.appendChild(moedasEl(row.moedas));
        lista.appendChild(li);
      }
    });
    anterior = novo;
    $('atualizado').textContent = 'Atualizado às ' + new Date(r.atualizadoEm)
      .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderLive(l) {
    $('live').dataset.on = l.aoVivo ? 'true' : 'false';
    $('live-txt').textContent = l.aoVivo ? 'Ao vivo agora' : 'Offline';
  }

  function conectar() {
    if (!window.EventSource) {
      var buscar = function () { fetch('/api/ranking').then(function (r) { return r.json(); }).then(renderRanking); };
      buscar();
      setInterval(buscar, 15000);
      return;
    }
    var es = new EventSource('/api/stream');
    es.addEventListener('open', function () { $('conexao').textContent = 'Tempo real'; $('conexao').classList.add('ok'); });
    es.addEventListener('error', function () { $('conexao').textContent = 'Reconectando...'; $('conexao').classList.remove('ok'); });
    es.addEventListener('ranking', function (e) { renderRanking(JSON.parse(e.data)); });
    es.addEventListener('live', function (e) { renderLive(JSON.parse(e.data)); });
    // Você mudou prêmio, entregas ou textos no painel: recarrega essa parte.
    es.addEventListener('site', function () { carregarSite(); });
  }

  // ---------- Contagem regressiva ----------
  var fimMs = 0;
  var desvio = 0; // diferença entre o relógio do servidor e o do celular
  var recarregando = false;

  function dois(n) { return n < 10 ? '0' + n : String(n); }

  function tick() {
    if (!fimMs) return;
    var resta = fimMs - (Date.now() + desvio);
    var box = document.querySelector('.countdown');
    var fechado = resta <= 0;
    box.classList.toggle('fechado', fechado);
    $('cd-label').hidden = fechado;
    $('cd-fechado').hidden = !fechado;
    if (fechado) {
      // Na virada do mês, recarrega o conteúdo uma vez para pegar o novo mês.
      if (!recarregando) { recarregando = true; setTimeout(carregarSite, 6000); }
      return;
    }
    var s = Math.floor(resta / 1000);
    $('cd-d').textContent = dois(Math.floor(s / 86400));
    $('cd-h').textContent = dois(Math.floor(s % 86400 / 3600));
    $('cd-m').textContent = dois(Math.floor(s % 3600 / 60));
    $('cd-s').textContent = dois(s % 60);
  }

  // ---------- Prêmio ----------
  function abrirZoom(src, alt) {
    var d = $('zoom');
    $('zoom-img').src = src;
    $('zoom-img').alt = alt || '';
    if (d.showModal) d.showModal(); else window.open(src, '_blank');
  }

  function renderPremio(site) {
    $('pr-mes').textContent = nomeMes(site.mes);
    var p = site.premio;
    var gal = $('galeria');
    var dots = $('dots');
    gal.textContent = '';
    dots.textContent = '';
    if (!p) {
      gal.hidden = true;
      dots.hidden = true;
      return;
    }
    $('pr-titulo').textContent = p.titulo;
    $('pr-desc').textContent = p.descricao || '';
    gal.hidden = p.imagens.length === 0;
    dots.hidden = p.imagens.length < 2;
    p.imagens.forEach(function (img, i) {
      var b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Ampliar imagem ' + (i + 1));
      var im = el('img');
      im.src = img.url;
      im.alt = img.alt || p.titulo;
      im.loading = i === 0 ? 'eager' : 'lazy';
      b.appendChild(im);
      b.addEventListener('click', function () { abrirZoom(img.url, im.alt); });
      gal.appendChild(b);
      dots.appendChild(el('span', i === 0 ? 'on' : ''));
    });
    gal.onscroll = function () {
      var i = Math.round(gal.scrollLeft / gal.clientWidth);
      Array.prototype.forEach.call(dots.children, function (d, j) { d.className = j === i ? 'on' : ''; });
    };
  }

  // ---------- Entregas ----------
  function renderEntregas(lista) {
    var box = $('entregas-lista');
    box.textContent = '';
    $('entregas-vazio').hidden = lista.length > 0;
    lista.forEach(function (e) {
      var card = el('article', 'entrega panel');
      var foto;
      if (e.foto) {
        foto = el('button', 'foto');
        foto.type = 'button';
        foto.style.backgroundImage = 'url("' + e.foto.replace(/"/g, '%22') + '")';
        foto.setAttribute('aria-label', 'Ver foto da entrega para ' + e.ganhador);
        foto.addEventListener('click', function () { abrirZoom(e.foto, 'Entrega para ' + e.ganhador); });
      } else {
        foto = el('div', 'foto', '#1');
      }
      card.appendChild(foto);
      var txt = el('div');
      txt.appendChild(el('p', 'mes', 'Campeão de ' + mesCurto(e.mes) + (e.moedas ? ' · ' + fmt.format(e.moedas) + ' moedas' : '')));
      txt.appendChild(el('p', 'quem', e.ganhador));
      txt.appendChild(el('p', 'oque', e.premio + (e.obs ? ' · ' + e.obs : '')));
      var st = e.status === 'entregue'
        ? 'Entregue' + (e.entregueEm ? ' em ' + e.entregueEm.split('-').reverse().join('/') : '')
        : 'Aguardando entrega';
      txt.appendChild(el('span', 'status ' + e.status, st));
      card.appendChild(txt);
      box.appendChild(card);
    });
  }

  // ---------- Agenda, regras e privacidade ----------
  function renderRegras(site) {
    var ag = $('agenda');
    ag.textContent = '';
    (site.agenda || []).forEach(function (a) {
      var li = el('li');
      li.appendChild(el('span', 'dia', a.dia));
      li.appendChild(el('span', 'hora', a.horario));
      ag.appendChild(li);
    });
    $('agenda-vazia').hidden = (site.agenda || []).length > 0;
    var rg = $('regras-lista');
    rg.textContent = '';
    (site.regras || []).forEach(function (t) { rg.appendChild(el('li', '', t)); });
    $('privacidade').textContent = site.privacidade || '';
  }

  function carregarSite() {
    fetch('/api/site', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (site) {
        desvio = new Date(site.agora).getTime() - Date.now();
        fimMs = new Date(site.fimDoMes).getTime();
        $('cd-mes').textContent = nomeMes(site.mes);
        recarregando = false;
        tick();
        renderPremio(site);
        renderEntregas(site.entregas || []);
        renderRegras(site);
      })
      .catch(function () { setTimeout(carregarSite, 10000); });
  }

  // ---------- Aba ativa conforme a rolagem ----------
  function abas() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.tabs a'));
    if (!('IntersectionObserver' in window)) return;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(function (a) { var s = document.querySelector(a.getAttribute('href')); if (s) obs.observe(s); });
  }

  conectar();
  carregarSite();
  setInterval(tick, 1000);
  setInterval(carregarSite, 5 * 60 * 1000); // pega mudanças do painel a cada 5 min
  abas();
})();
