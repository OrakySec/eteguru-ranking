// Painel do @eteguru: login, ranking completo, pessoas, correções, prêmio, entregas e textos.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat('pt-BR');
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var mesAtual = '';

  // ---------- Utilidades ----------

  /** Cria um elemento: h('div', {class: 'x', onclick: fn}, 'texto', outroElemento) */
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else if (k === 'class') e.className = v;
        else if (k === 'value') e.value = v;
        else if (k === 'checked') e.checked = !!v;
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }

  function toast(msg, erro) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (erro ? ' erro-t' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function api(method, url, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && url !== '/api/admin/login') { mostrarLogin(); throw new Error(data.erro || 'Faça login.'); }
        if (!r.ok) throw new Error(data.erro || 'Erro ' + r.status);
        return data;
      });
    });
  }

  function falhou(err) { toast(err.message || 'Erro', true); }

  function dataHora(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function nomeMes(m) { return MESES[Number(m.slice(5, 7)) - 1] + ' de ' + m.slice(0, 4); }
  function moedas(n) { return fmt.format(n) + ' moedas'; }
  function nomePessoa(p) { return p.display_name || p.nickname || p.nome || 'Anônimo'; }

  /** Desliga o botão enquanto a ação roda (evita clique duplo). */
  function acao(btn, fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      btn.disabled = true;
      Promise.resolve().then(fn).catch(falhou).then(function () { btn.disabled = false; });
    };
  }

  function campoMes(name, valor) {
    return h('input', { type: 'month', name: name, value: valor || mesAtual, required: true, pattern: '\\d{4}-\\d{2}', placeholder: 'AAAA-MM' });
  }

  // ---------- Login ----------

  function mostrarLogin() {
    $('v-app').hidden = true;
    $('v-login').hidden = false;
  }

  $('f-login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = ev.target.querySelector('button');
    btn.disabled = true;
    $('login-erro').textContent = '';
    api('POST', '/api/admin/login', { senha: ev.target.senha.value })
      .then(function () { ev.target.reset(); iniciar(); })
      .catch(function (err) { $('login-erro').textContent = err.message; })
      .then(function () { btn.disabled = false; });
  });

  $('sair').addEventListener('click', function () {
    api('POST', '/api/admin/logout', {}).then(mostrarLogin, mostrarLogin);
  });

  // ---------- Navegação ----------

  var telas = {
    inicio: telaInicio, ranking: telaRanking, pessoas: telaPessoas, premio: telaPremio,
    entregas: telaEntregas, textos: telaTextos, auditoria: telaAuditoria,
  };

  function abrirTela() {
    var nome = (location.hash || '#inicio').slice(1);
    if (!telas[nome]) nome = 'inicio';
    Array.prototype.forEach.call(document.querySelectorAll('#abas a'), function (a) {
      a.classList.toggle('on', a.getAttribute('href') === '#' + nome);
    });
    var box = $('conteudo');
    box.textContent = '';
    box.appendChild(h('p', { class: 'vazio-adm' }, 'Carregando...'));
    Promise.resolve(telas[nome]()).then(function (el) {
      box.textContent = '';
      add(box, el);
    }).catch(function (err) {
      box.textContent = '';
      box.appendChild(h('p', { class: 'erro' }, err.message));
    });
  }
  window.addEventListener('hashchange', abrirTela);

  function iniciar() {
    api('GET', '/api/admin/me').then(function (me) {
      mesAtual = me.mesAtual;
      $('v-login').hidden = true;
      $('v-app').hidden = false;
      abrirTela();
    }).catch(function () { mostrarLogin(); });
  }

  // ---------- Início ----------

  function cardTelegram(t) {
    var card = h('section', { class: 'panel card' }, h('h3', null, 'Alertas no Telegram'));
    if (!t.configurado) {
      add(card, h('p', { class: 'ajuda' }, 'Desligado: falta a variável TELEGRAM_BOT_TOKEN no Portainer. O passo a passo está no guia da Etapa 6.'));
      return card;
    }
    var bVinc = h('button', { class: 'btn' + (t.vinculado ? ' sec' : '') }, t.vinculado ? 'Vincular de novo' : 'Vincular meu Telegram');
    bVinc.addEventListener('click', acao(bVinc, function () {
      return api('POST', '/api/admin/telegram/vincular', {}).then(function (r) { toast('Vinculado a ' + r.nome + '. Confira o Telegram.'); abrirTela(); });
    }));
    var bTeste = h('button', { class: 'btn sec' }, 'Enviar teste');
    bTeste.addEventListener('click', acao(bTeste, function () {
      return api('POST', '/api/admin/telegram/teste', {}).then(function () { toast('Teste enviado. Confira o Telegram.'); });
    }));
    var chk = h('input', { type: 'checkbox', checked: t.avisarInicioFim });
    chk.addEventListener('change', function () {
      api('PUT', '/api/admin/telegram', { avisarInicioFim: chk.checked })
        .then(function () { toast('Preferência salva.'); })
        .catch(function (e) { chk.checked = !chk.checked; falhou(e); });
    });
    add(card, [
      h('p', { class: 'ajuda' }, t.vinculado
        ? 'Enviando para: ' + t.nome + '. Você recebe aviso se a conexão cair durante a live ou se não conseguir conectar.'
        : 'Abra o seu bot no Telegram, toque em Iniciar e depois toque no botão abaixo.'),
      t.vinculado ? h('label', { class: 'check' }, chk, 'Avisar também início e fim da live (com resumo)') : null,
      h('div', { class: 'acoes' }, bVinc, t.vinculado ? bTeste : null),
    ]);
    return card;
  }

  function telaInicio() {
    return Promise.all([api('GET', '/api/admin/resumo'), api('GET', '/api/admin/telegram')]).then(function (res) {
      var r = res[0];
      var on = r.live.status === 'conectado';
      var nomes = {
        conectado: 'Conectado na live', 'aguardando-live': 'Aguardando a live', conectando: 'Conectando...',
        reconectando: 'Reconectando...', parado: 'Coletor parado',
      };
      return [
        h('section', { class: 'panel card' },
          h('h3', null, 'Conexão com a live ' + r.live.usuario),
          h('p', { class: 'status-live' + (on ? ' on' : '') }, h('span', { class: 'dot' }), nomes[r.live.status] || r.live.status),
          h('p', { class: 'ajuda' },
            on ? 'Conectado desde ' + dataHora(r.live.conectadoDesde) + '. ' : '',
            r.live.ultimoPresente ? 'Último presente: ' + dataHora(r.live.ultimoPresente) + '.' : 'Nenhum presente desde que o serviço ligou.'),
          h('h3', null, 'Histórico da conexão'),
          h('ul', { class: 'itens' }, r.conexao.length ? r.conexao.map(function (c) {
            return h('li', null, h('div', { class: 'principal' }, h('span', null, nomes[c.status] || c.status), h('span', { class: 'sub' }, dataHora(c.at))),
              c.detail ? h('div', { class: 'sub' }, c.detail) : null);
          }) : h('li', { class: 'vazio-adm' }, 'Sem registros ainda.'))),
        cardTelegram(res[1]),
        h('section', { class: 'panel card' },
          h('h3', null, 'Últimos presentes recebidos'),
          h('ul', { class: 'itens' }, r.presentes.length ? r.presentes.map(function (g) {
            return h('li', null,
              h('button', { class: 'linha-btn', onclick: function () { abrirPessoa(g.user_id); } },
                h('div', { class: 'principal' }, h('span', { class: 'nome' }, g.nickname || g.unique_id),
                  h('span', { class: 'valor' }, fmt.format(g.coins_total))),
                h('div', { class: 'sub' }, '@' + g.unique_id + ' · ' + g.quantity + 'x ' + g.gift_name + ' · ' + dataHora(g.sent_at),
                  g.to_host ? null : h('span', { class: 'pill vermelho' }, 'para convidado @' + (g.to_unique_id || '?')))));
          }) : h('li', { class: 'vazio-adm' }, 'Nenhum presente gravado ainda.'))),
      ];
    });
  }

  // ---------- Ranking completo ----------

  var filtroRanking = { mes: '', periodo: '' };

  function telaRanking() {
    var q = filtroRanking.periodo === '30d' ? '?periodo=30d' : '?mes=' + (filtroRanking.mes || mesAtual);
    return api('GET', '/api/admin/ranking' + q).then(function (r) {
      var inputMes = campoMes('mes', filtroRanking.mes || mesAtual);
      var form = h('form', { class: 'periodo' },
        h('label', null, 'Mês', inputMes),
        h('button', { class: 'btn sec' }, 'Ver'),
        h('button', { class: 'btn sec', type: 'button', onclick: function () { filtroRanking = { mes: '', periodo: '30d' }; abrirTela(); } }, '30 dias'));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        filtroRanking = { mes: inputMes.value, periodo: '' };
        abrirTela();
      });
      var titulo = r.periodo.tipo === '30dias' ? 'Últimos 30 dias' : nomeMes(r.periodo.mes);
      var planilha = r.periodo.mes
        ? h('a', { class: 'btn sec mini', href: '/api/admin/exportar.csv?mes=' + r.periodo.mes, download: true }, 'Baixar planilha do mês')
        : null;
      return h('section', { class: 'panel card' },
        h('h2', null, titulo),
        h('p', { class: 'ajuda' }, 'Lista completa, incluindo quem está escondido. Toque numa pessoa para renomear, esconder ou corrigir pontos.'),
        form,
        planilha ? h('p', null, planilha, ' ', h('span', { class: 'muted' }, 'Todos os presentes e correções, para conferir com o TikTok.')) : null,
        h('ul', { class: 'itens' }, r.linhas.length ? r.linhas.map(function (l) {
          return h('li', null, h('button', { class: 'linha-btn', onclick: function () { abrirPessoa(l.user_id); } },
            h('div', { class: 'principal' },
              h('span', { class: 'nome' }, (l.posicaoPublica ? l.posicaoPublica + 'º ' : '') + l.nome,
                l.hidden ? h('span', { class: 'pill vermelho' }, 'escondido') : null,
                l.manual ? h('span', { class: 'pill' }, 'manual') : null),
              h('span', { class: 'valor' }, fmt.format(l.moedas))),
            h('div', { class: 'sub' }, '@' + l.unique_id + ' · ' + l.presentes + (l.presentes === 1 ? ' presente' : ' presentes') +
              (l.correcoes ? ' · correções: ' + (l.correcoes > 0 ? '+' : '') + fmt.format(l.correcoes) : ''))));
        }) : h('li', { class: 'vazio-adm' }, 'Ninguém pontuou nesse período.')));
    });
  }

  // ---------- Pessoas ----------

  var ultimaBusca = '';

  function telaPessoas() {
    var busca = h('input', { type: 'search', name: 'busca', value: ultimaBusca, placeholder: 'Nome ou @', autocomplete: 'off' });
    var lista = h('ul', { class: 'itens' });

    function buscar() {
      ultimaBusca = busca.value;
      return api('GET', '/api/admin/pessoas?busca=' + encodeURIComponent(busca.value)).then(function (rows) {
        lista.textContent = '';
        if (!rows.length) lista.appendChild(h('li', { class: 'vazio-adm' }, 'Ninguém encontrado.'));
        rows.forEach(function (p) {
          lista.appendChild(h('li', null, h('button', { class: 'linha-btn', onclick: function () { abrirPessoa(p.user_id); } },
            h('div', { class: 'principal' },
              h('span', { class: 'nome' }, nomePessoa(p),
                p.hidden ? h('span', { class: 'pill vermelho' }, 'escondido') : null,
                p.manual ? h('span', { class: 'pill' }, 'manual') : null),
              h('span', { class: 'valor' }, fmt.format(p.moedas_total))),
            h('div', { class: 'sub' }, '@' + p.unique_id + (p.display_name ? ' · apelido no TikTok: ' + p.nickname : '')))));
        });
      });
    }
    var timer;
    busca.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { buscar().catch(falhou); }, 300); });

    var fCad = h('form', null,
      h('div', { class: 'linha' },
        h('label', null, '@ no TikTok', h('input', { name: 'arroba', required: true, placeholder: 'fulano', autocapitalize: 'off', autocomplete: 'off' })),
        h('label', null, 'Apelido', h('input', { name: 'apelido', placeholder: 'Até o 1º presente' }))),
      h('button', { class: 'btn' }, 'Cadastrar'));
    fCad.addEventListener('submit', acao(fCad.querySelector('button'), function () {
      return api('POST', '/api/admin/pessoas', { arroba: fCad.arroba.value, apelido: fCad.apelido.value }).then(function (r) {
        toast('Cadastrado. Agora lance os pontos.');
        fCad.reset();
        abrirPessoa(r.user_id);
        return buscar();
      });
    }));

    return buscar().then(function () {
      return [
        h('section', { class: 'panel card' }, h('h2', null, 'Pessoas'), h('label', null, 'Buscar', busca), lista),
        h('section', { class: 'panel card' },
          h('h3', null, 'Cadastrar pelo @'),
          h('p', { class: 'ajuda' }, 'Para lançar pontos de quem ainda não mandou presente desde que o sistema entrou no ar. ' +
            'No primeiro presente da pessoa, o sistema junta tudo sozinho com o cadastro real e passa a usar o apelido do TikTok ' +
            '(se quiser outro nome, defina em "Nome no site").'),
          fCad),
      ];
    });
  }

  // Janela com os detalhes de uma pessoa
  function abrirPessoa(userId) {
    var d = $('d-pessoa');
    d.textContent = '';
    d.appendChild(h('div', { class: 'sheet-in' }, 'Carregando...'));
    if (!d.open) d.showModal();
    api('GET', '/api/admin/pessoas/' + encodeURIComponent(userId)).then(function (r) {
      var p = r.pessoa;
      d.textContent = '';

      var fNome = h('form', null,
        h('label', null, 'Nome no site (vazio = apelido do TikTok)',
          h('input', { name: 'nome', value: p.display_name || '', placeholder: p.nickname, maxlength: 40 })),
        h('button', { class: 'btn sec' }, 'Salvar nome'));
      fNome.addEventListener('submit', acao(fNome.querySelector('button'), function () {
        return api('PATCH', '/api/admin/pessoas/' + encodeURIComponent(userId), { display_name: fNome.nome.value })
          .then(function () { toast('Nome salvo.'); abrirPessoa(userId); recarregarFundo(); });
      }));

      var chk = h('input', { type: 'checkbox', checked: p.hidden });
      chk.addEventListener('change', function () {
        api('PATCH', '/api/admin/pessoas/' + encodeURIComponent(userId), { hidden: chk.checked })
          .then(function () { toast(chk.checked ? 'Escondido do site.' : 'Visível no site.'); recarregarFundo(); })
          .catch(function (e) { chk.checked = !chk.checked; falhou(e); });
      });

      var fCor = h('form', null,
        h('div', { class: 'linha' },
          h('label', null, 'Mês', campoMes('mes')),
          h('label', null, 'Moedas (+ ou -)', h('input', { name: 'moedas', type: 'number', inputmode: 'numeric', required: true, step: 1 }))),
        h('label', null, 'Motivo', h('input', { name: 'motivo', required: true, minlength: 3, maxlength: 300,
          placeholder: 'Ex.: presentes de 01 a 12/11, antes do sistema' })),
        h('button', { class: 'btn' }, 'Lançar correção'));
      fCor.addEventListener('submit', acao(fCor.querySelector('button'), function () {
        return api('POST', '/api/admin/correcoes', {
          user_id: userId, mes: fCor.mes.value, moedas: fCor.moedas.value, motivo: fCor.motivo.value,
        }).then(function () { toast('Correção lançada.'); abrirPessoa(userId); recarregarFundo(); });
      }));

      var listaCor = h('ul', { class: 'itens' }, r.correcoes.length ? r.correcoes.map(function (c) {
        var b = h('button', { class: 'btn perigo mini' }, 'Apagar');
        b.addEventListener('click', acao(b, function () {
          if (!confirm('Apagar a correção de ' + fmt.format(c.coins) + ' moedas?')) return;
          return api('DELETE', '/api/admin/correcoes/' + c.id).then(function () { toast('Correção apagada.'); abrirPessoa(userId); recarregarFundo(); });
        }));
        return h('li', null,
          h('div', { class: 'principal' }, h('span', null, nomeMes(c.month)),
            h('span', { class: 'valor' + (c.coins < 0 ? ' neg' : '') }, (c.coins > 0 ? '+' : '') + fmt.format(c.coins))),
          h('div', { class: 'sub' }, c.reason + ' · ' + dataHora(c.created_at)), b);
      }) : h('li', { class: 'vazio-adm' }, 'Nenhuma correção.'));

      var listaGifts = h('ul', { class: 'itens' }, r.presentes.length ? r.presentes.map(function (g) {
        return h('li', null, h('div', { class: 'principal' }, h('span', null, g.quantity + 'x ' + g.gift_name,
          g.to_host ? null : h('span', { class: 'pill vermelho' }, 'convidado')),
          h('span', { class: 'valor' }, fmt.format(g.coins_total))), h('div', { class: 'sub' }, dataHora(g.sent_at)));
      }) : h('li', { class: 'vazio-adm' }, 'Nenhum presente registrado.'));

      var apagar = null;
      if (p.manual) {
        apagar = h('button', { class: 'btn perigo' }, 'Apagar cadastro manual');
        apagar.addEventListener('click', acao(apagar, function () {
          if (!confirm('Apagar o cadastro manual de @' + p.unique_id + '?')) return;
          return api('DELETE', '/api/admin/pessoas/' + encodeURIComponent(userId)).then(function () { toast('Cadastro apagado.'); d.close(); recarregarFundo(); });
        }));
      }

      var fechar = h('button', { class: 'link', onclick: function () { d.close(); } }, 'Fechar');
      d.appendChild(h('div', { class: 'sheet-top' },
        h('div', null, h('h2', null, nomePessoa(p)),
          h('p', null, '@' + p.unique_id + ' · ' + (p.manual ? 'cadastro manual, aguardando o primeiro presente' : 'ID ' + p.user_id))),
        fechar));
      d.appendChild(h('div', { class: 'sheet-in' },
        h('h3', null, 'Como aparece no site'), fNome,
        h('label', { class: 'check' }, chk, 'Esconder do ranking público'),
        h('h3', null, 'Corrigir pontuação'),
        h('p', { class: 'ajuda' }, 'Use número negativo para tirar pontos. Fica tudo registrado na auditoria.'),
        fCor,
        h('h3', null, 'Correções lançadas'), listaCor,
        h('h3', null, 'Últimos presentes'), listaGifts,
        apagar ? h('h3', null, 'Cadastro') : null, apagar));
    }).catch(function (e) { d.close(); falhou(e); });
  }
  $('d-pessoa').addEventListener('click', function (ev) { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

  /** Atualiza a tela que está atrás da janela (ranking, pessoas...). */
  function recarregarFundo() {
    var nome = (location.hash || '#inicio').slice(1);
    if (nome === 'ranking' || nome === 'pessoas' || nome === 'inicio') {
      Promise.resolve(telas[nome]()).then(function (el) { var box = $('conteudo'); box.textContent = ''; add(box, el); }).catch(function () {});
    }
  }

  // ---------- Prêmio ----------

  var mesPremio = '';

  function telaPremio() {
    var mes = mesPremio || mesAtual;
    return api('GET', '/api/admin/premio?mes=' + mes).then(function (p) {
      var inputMes = campoMes('mes', mes);
      inputMes.addEventListener('change', function () { if (/^\d{4}-\d{2}$/.test(inputMes.value)) { mesPremio = inputMes.value; abrirTela(); } });

      var f = h('form', null,
        h('label', null, 'Nome do prêmio', h('input', { name: 'titulo', value: p.titulo, required: true, maxlength: 80, placeholder: 'Ex.: Headset gamer' })),
        h('label', null, 'Descrição', h('textarea', { name: 'descricao', maxlength: 2000, placeholder: 'Detalhes, como é entregue etc.' }, p.descricao)),
        h('button', { class: 'btn' }, 'Salvar prêmio'));
      f.addEventListener('submit', acao(f.querySelector('button'), function () {
        return api('PUT', '/api/admin/premio', { mes: mes, titulo: f.titulo.value, descricao: f.descricao.value })
          .then(function () { toast('Prêmio salvo.'); abrirTela(); });
      }));

      var fotos = h('div', { class: 'fotos' }, p.imagens.map(function (img, i) {
        var bPri = h('button', { class: 'btn sec mini', disabled: i === 0 }, i === 0 ? 'Capa' : 'Virar capa');
        bPri.addEventListener('click', acao(bPri, function () {
          return api('POST', '/api/admin/imagens/' + img.id + '/primeira', {}).then(abrirTela);
        }));
        var bDel = h('button', { class: 'btn perigo mini' }, 'Apagar');
        bDel.addEventListener('click', acao(bDel, function () {
          if (!confirm('Apagar esta foto?')) return;
          return api('DELETE', '/api/admin/imagens/' + img.id).then(function () { toast('Foto apagada.'); abrirTela(); });
        }));
        return h('figure', null, h('img', { src: '/uploads/' + encodeURIComponent(img.file), alt: '' }), h('figcaption', null, bPri, bDel));
      }));

      var arquivo = h('input', { type: 'file', accept: 'image/*', multiple: true });
      var bEnviar = h('button', { class: 'btn sec', disabled: !p.titulo }, 'Enviar fotos');
      bEnviar.addEventListener('click', acao(bEnviar, function () {
        if (!arquivo.files.length) throw new Error('Escolha uma ou mais fotos.');
        var fd = new FormData();
        Array.prototype.forEach.call(arquivo.files, function (file) { fd.append('fotos', file); });
        bEnviar.textContent = 'Enviando...';
        return api('POST', '/api/admin/premio/' + mes + '/imagens', fd).then(function () { toast('Fotos enviadas.'); abrirTela(); })
          .finally(function () { bEnviar.textContent = 'Enviar fotos'; });
      }));

      return h('section', { class: 'panel card' },
        h('h2', null, 'Prêmio do mês'),
        h('label', null, 'Mês', inputMes),
        f,
        h('h3', null, 'Fotos'),
        p.titulo ? null : h('p', { class: 'ajuda' }, 'Salve o nome do prêmio antes de enviar fotos.'),
        p.imagens.length ? fotos : h('p', { class: 'vazio-adm' }, 'Nenhuma foto ainda.'),
        h('p', { class: 'ajuda' }, 'As fotos são reduzidas automaticamente e a localização (GPS) é apagada. Use fotos suas, sem logos ou imagens oficiais de jogos.'),
        h('label', null, 'Escolher fotos', arquivo),
        bEnviar);
    });
  }

  // ---------- Entregas ----------

  function telaEntregas() {
    return api('GET', '/api/admin/entregas').then(function (rows) {
      var lista = h('div', null, rows.length ? rows.map(function (e) {
        var bEd = h('button', { class: 'btn sec mini', onclick: function () { formEntrega(e); window.scrollTo(0, 0); } }, 'Editar');
        var arq = h('input', { type: 'file', accept: 'image/*', hidden: true });
        var bFoto = h('button', { class: 'btn sec mini', onclick: function () { arq.click(); } }, e.photo ? 'Trocar foto' : 'Foto');
        arq.addEventListener('change', acao(bFoto, function () {
          if (!arq.files.length) return;
          var fd = new FormData();
          fd.append('foto', arq.files[0]);
          return api('POST', '/api/admin/entregas/' + e.id + '/foto', fd).then(function () { toast('Foto enviada.'); abrirTela(); });
        }));
        var bDel = h('button', { class: 'btn perigo mini' }, 'Apagar');
        bDel.addEventListener('click', acao(bDel, function () {
          if (!confirm('Apagar o registro de ' + e.winner_name + '?')) return;
          return api('DELETE', '/api/admin/entregas/' + e.id).then(function () { toast('Apagado.'); abrirTela(); });
        }));
        return h('div', { class: 'panel card entrega-adm' },
          h('div', { class: 'thumb', style: e.photo ? 'background-image:url("/uploads/' + encodeURIComponent(e.photo) + '")' : null }),
          h('div', null,
            h('div', { class: 'sub' }, nomeMes(e.month)),
            h('div', { class: 'nome' }, e.winner_name, ' ', h('span', { class: 'pill' + (e.status === 'entregue' ? ' laranja' : '') },
              e.status === 'entregue' ? 'entregue' : 'aguardando')),
            h('div', { class: 'sub' }, e.prize_title + (e.coins ? ' · ' + moedas(e.coins) : '')),
            h('div', { class: 'acoes' }, bEd, bFoto, bDel, arq)));
      }) : h('p', { class: 'vazio-adm' }, 'Nenhum ganhador registrado ainda.'));

      var box = h('section', { class: 'panel card', id: 'form-entrega' });
      function formEntrega(e) {
        e = e || null;
        box.textContent = '';
        var userId = e ? e.user_id : '';
        var f = h('form', null,
          h('div', { class: 'linha' },
            h('label', null, 'Mês do ranking', campoMes('mes', e ? e.month : ultimoMesFechado())),
            h('label', null, 'Moedas finais', h('input', { name: 'moedas', type: 'number', inputmode: 'numeric', value: e && e.coins != null ? e.coins : '' }))),
          h('label', null, 'Ganhador (nome no site)', h('input', { name: 'ganhador', required: true, maxlength: 40, value: e ? e.winner_name : '' })),
          h('label', null, 'Prêmio', h('input', { name: 'premio', required: true, maxlength: 80, value: e ? e.prize_title : '' })),
          h('div', { class: 'linha' },
            h('label', null, 'Status', h('select', { name: 'status' },
              h('option', { value: 'aguardando' }, 'Aguardando entrega'),
              h('option', { value: 'entregue' }, 'Entregue'))),
            h('label', null, 'Data da entrega', h('input', { name: 'entregue_em', type: 'date', value: e && e.delivered_at ? e.delivered_at : '' }))),
          h('label', null, 'Observação (opcional)', h('input', { name: 'obs', maxlength: 200, value: e ? e.note : '' })),
          h('div', { class: 'acoes' },
            h('button', { class: 'btn' }, e ? 'Salvar alterações' : 'Registrar ganhador'),
            e ? h('button', { class: 'btn sec', type: 'button', onclick: function () { formEntrega(null); } }, 'Cancelar') : null));
        f.status.value = e ? e.status : 'aguardando';

        var bTop = h('button', { class: 'btn sec', type: 'button' }, 'Preencher com o TOP 1 desse mês');
        bTop.addEventListener('click', acao(bTop, function () {
          var m = f.mes.value;
          return Promise.all([api('GET', '/api/admin/ranking?mes=' + m), api('GET', '/api/admin/premio?mes=' + m)]).then(function (res) {
            var top = res[0].linhas.filter(function (l) { return !l.hidden; })[0];
            if (!top) throw new Error('Ninguém pontuou em ' + nomeMes(m) + '.');
            f.ganhador.value = top.nome;
            f.moedas.value = top.moedas;
            userId = top.user_id;
            if (res[1].titulo && !f.premio.value) f.premio.value = res[1].titulo;
            toast('Preenchido com ' + top.nome + '. Confira com o ranking oficial do TikTok.');
          });
        }));

        f.addEventListener('submit', acao(f.querySelector('button'), function () {
          var body = {
            mes: f.mes.value, ganhador: f.ganhador.value, premio: f.premio.value, moedas: f.moedas.value,
            status: f.status.value, entregue_em: f.entregue_em.value, obs: f.obs.value, user_id: userId,
          };
          var req = e ? api('PUT', '/api/admin/entregas/' + e.id, body) : api('POST', '/api/admin/entregas', body);
          return req.then(function () { toast(e ? 'Alterações salvas.' : 'Ganhador registrado.'); abrirTela(); });
        }));

        add(box, [
          h('h2', null, e ? 'Editar registro' : 'Registrar ganhador'),
          h('p', { class: 'ajuda' }, 'O ranking oficial do TikTok é a referência final. Confira antes de registrar.'),
          e ? null : bTop,
          h('div', { style: 'height:12px' }),
          f,
        ]);
      }
      formEntrega(null);
      return [box, h('h2', { style: 'margin:24px 0 4px' }, 'Registros'), lista];
    });
  }

  function ultimoMesFechado() {
    var y = Number(mesAtual.slice(0, 4));
    var m = Number(mesAtual.slice(5, 7)) - 1;
    if (m === 0) { m = 12; y--; }
    return y + '-' + (m < 10 ? '0' + m : m);
  }

  // ---------- Textos do site ----------

  function telaTextos() {
    return api('GET', '/api/admin/textos').then(function (t) {
      var linhas = h('div');
      function linhaAgenda(a) {
        var row = h('div', { class: 'linha' },
          h('label', null, 'Dia', h('input', { name: 'dia', value: a.dia || '', maxlength: 40, placeholder: 'Ex.: Segunda a sexta' })),
          h('label', null, 'Horário', h('input', { name: 'horario', value: a.horario || '', maxlength: 40, placeholder: 'Ex.: 20h às 23h' })));
        linhas.appendChild(row);
      }
      (t.agenda.length ? t.agenda : [{}]).forEach(linhaAgenda);
      var regras = h('textarea', { name: 'regras', rows: 8 }, (t.regras || []).join('\n'));
      var priv = h('textarea', { name: 'privacidade', rows: 4, required: true }, t.privacidade || '');
      var bSalvar = h('button', { class: 'btn full' }, 'Salvar textos');

      var f = h('form', null,
        h('h3', null, 'Horários das lives'),
        h('p', { class: 'ajuda' }, 'Deixe dia e horário vazios para remover uma linha.'),
        linhas,
        h('button', { class: 'btn sec mini', type: 'button', onclick: function () { linhaAgenda({}); } }, '+ Adicionar horário'),
        h('h3', null, 'Regras resumidas'),
        h('p', { class: 'ajuda' }, 'Uma regra por linha.'),
        regras,
        h('h3', null, 'Aviso de privacidade (LGPD)'),
        priv,
        h('div', { style: 'height:12px' }),
        bSalvar);
      f.addEventListener('submit', acao(bSalvar, function () {
        var agenda = Array.prototype.map.call(linhas.children, function (row) {
          return { dia: row.querySelector('[name=dia]').value, horario: row.querySelector('[name=horario]').value };
        });
        return api('PUT', '/api/admin/textos', {
          agenda: agenda, regras: regras.value.split('\n'), privacidade: priv.value,
        }).then(function () { toast('Textos salvos. O site já foi atualizado.'); abrirTela(); });
      }));
      return h('section', { class: 'panel card' }, h('h2', null, 'Textos do site'), f);
    });
  }

  // ---------- Auditoria ----------

  function telaAuditoria() {
    return api('GET', '/api/admin/log').then(function (rows) {
      return h('section', { class: 'panel card' },
        h('h2', null, 'Auditoria'),
        h('p', { class: 'ajuda' }, 'Tudo que foi feito no painel, do mais recente para o mais antigo.'),
        h('ul', { class: 'itens' }, rows.length ? rows.map(function (r) {
          var det = Object.keys(r.details || {}).map(function (k) { return k + ': ' + r.details[k]; }).join(' · ');
          return h('li', null,
            h('div', { class: 'principal' }, h('span', null, r.action), h('span', { class: 'sub' }, dataHora(r.at))),
            det ? h('div', { class: 'sub' }, det) : null);
        }) : h('li', { class: 'vazio-adm' }, 'Nada registrado ainda.')));
    });
  }

  iniciar();
})();
