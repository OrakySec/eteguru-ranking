// Página pública do ranking: recebe atualizações em tempo real pelo /api/stream (SSE).
(function () {
  'use strict';

  var lista = document.getElementById('lista');
  var conexao = document.getElementById('conexao');
  var atualizado = document.getElementById('atualizado');
  var live = document.getElementById('live');
  var liveTxt = document.getElementById('live-txt');
  var titulo = document.getElementById('titulo');
  var anterior = {}; // id -> moedas, para destacar quem subiu

  var fmt = new Intl.NumberFormat('pt-BR');
  var meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderRanking(r) {
    if (r.periodo && r.periodo.mes) {
      var m = Number(r.periodo.mes.slice(5, 7));
      titulo.textContent = 'Top 10 de ' + meses[m - 1];
    }
    lista.textContent = '';
    if (!r.top || r.top.length === 0) {
      lista.appendChild(el('li', 'vazio', 'Ninguém pontuou ainda neste mês. O primeiro presente leva o topo!'));
    }
    var novo = {};
    r.top.forEach(function (row) {
      var li = el('li', row.posicao === 1 ? 'p1' : '');
      if (anterior[row.id] !== undefined && anterior[row.id] < row.moedas) li.classList.add('subiu');
      if (Object.keys(anterior).length && anterior[row.id] === undefined) li.classList.add('subiu');
      li.appendChild(el('span', 'pos', row.posicao + 'º'));
      li.appendChild(el('span', 'nome', row.nome));
      var m = el('span', 'moedas', fmt.format(row.moedas));
      m.appendChild(el('small', '', 'moedas'));
      li.appendChild(m);
      lista.appendChild(li);
      novo[row.id] = row.moedas;
    });
    anterior = novo;
    var d = new Date(r.atualizadoEm);
    atualizado.textContent = 'Atualizado ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderLive(l) {
    live.dataset.on = l.aoVivo ? 'true' : 'false';
    liveTxt.textContent = l.aoVivo ? 'Ao vivo agora' : 'Offline';
  }

  function conectar() {
    if (!window.EventSource) {
      // Navegador muito antigo: atualiza a cada 15 segundos.
      setInterval(function () {
        fetch('/api/ranking').then(function (r) { return r.json(); }).then(renderRanking);
      }, 15000);
      return;
    }
    var es = new EventSource('/api/stream');
    es.addEventListener('open', function () {
      conexao.textContent = 'Tempo real';
      conexao.classList.add('ok');
    });
    es.addEventListener('error', function () {
      conexao.textContent = 'Reconectando...';
      conexao.classList.remove('ok');
    });
    es.addEventListener('ranking', function (e) { renderRanking(JSON.parse(e.data)); });
    es.addEventListener('live', function (e) { renderLive(JSON.parse(e.data)); });
  }

  conectar();
})();
