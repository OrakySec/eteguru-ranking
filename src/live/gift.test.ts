import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideGift, type RawGiftMessage } from './gift.js';

const rosa = (repeatCount: number, repeatEnd: number, msgId: string): RawGiftMessage => ({
  common: { msgId, createTime: '1764558000000' },
  repeatCount,
  repeatEnd,
  groupId: 'g1',
  user: { id: '6813181309701719620', nickname: 'Fã Fiel', displayId: 'fafiel' },
  gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1 },
});

test('sequência de 5 rosas conta uma vez só, com 5 moedas', () => {
  const eventos = [rosa(1, 0, 'a'), rosa(2, 0, 'b'), rosa(3, 0, 'c'), rosa(4, 0, 'd'), rosa(5, 1, 'e')];
  const contados = eventos.map(decideGift).filter((d) => d.kind === 'count');
  assert.equal(contados.length, 1);
  const ev = (contados[0] as { kind: 'count'; event: { coinsTotal: number; quantity: number } }).event;
  assert.equal(ev.quantity, 5);
  assert.equal(ev.coinsTotal, 5);
});

test('presente que não faz sequência (tipo diferente de 1) conta direto', () => {
  const d = decideGift({
    common: { msgId: 'x', createTime: '1764558000000' },
    repeatCount: 1,
    repeatEnd: 0,
    user: { id: '1', nickname: 'A', displayId: 'a' },
    gift: { id: '99', name: 'Leão', type: 2, diamondCount: 29999 },
  });
  assert.equal(d.kind, 'count');
  if (d.kind === 'count') assert.equal(d.event.coinsTotal, 29999);
});

test('identifica a pessoa pelo ID, não pelo @', () => {
  const d = decideGift(rosa(1, 1, 'z'));
  assert.equal(d.kind, 'count');
  if (d.kind === 'count') {
    assert.equal(d.event.userId, '6813181309701719620');
    assert.equal(d.event.uniqueId, 'fafiel');
  }
});

test('evento sem usuário é ignorado', () => {
  assert.equal(decideGift({ gift: { type: 1, diamondCount: 1 } }).kind, 'ignored');
});

test('mesmo evento gera a mesma chave (para o banco descartar duplicado)', () => {
  const a = decideGift(rosa(5, 1, 'e'));
  const b = decideGift(rosa(5, 1, 'e'));
  assert.ok(a.kind === 'count' && b.kind === 'count');
  if (a.kind === 'count' && b.kind === 'count') assert.equal(a.event.eventKey, b.event.eventKey);
});
