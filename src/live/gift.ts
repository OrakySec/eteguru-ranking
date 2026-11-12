// Converte o evento bruto de presente do TikTok num registro limpo para o ranking.
// Regra de sequência (combo): presentes do tipo 1 disparam vários eventos enquanto
// a pessoa segura o botão, com repeatCount subindo. Só o último (repeatEnd = 1)
// é contado, com o repeatCount final. Os outros tipos chegam num evento só.

export interface GiftEvent {
  /** Chave única do evento, usada no banco para nunca gravar o mesmo presente duas vezes. */
  eventKey: string;
  /** ID numérico permanente do usuário no TikTok (não muda quando a pessoa troca o @). */
  userId: string;
  /** @ atual da pessoa (pode mudar). */
  uniqueId: string;
  /** Apelido exibido. */
  nickname: string;
  giftId: string;
  giftName: string;
  /** Preço de UMA unidade do presente, em moedas. */
  coinsEach: number;
  /** Quantidade final da sequência. */
  quantity: number;
  /** coinsEach x quantity: é isso que soma no ranking. */
  coinsTotal: number;
  /** Para quem foi o presente (em live com convidados pode ser outra pessoa). */
  toUserId: string | null;
  toUniqueId: string | null;
  /** Momento do presente, segundo o TikTok. */
  sentAt: Date;
}

/** Formato mínimo do evento da biblioteca que usamos (o real tem muito mais campos). */
export interface RawGiftMessage {
  common?: { msgId?: string; createTime?: string } | undefined;
  giftId?: string;
  repeatCount?: number;
  repeatEnd?: number | boolean;
  groupId?: string;
  user?: { id?: string; nickname?: string; displayId?: string; uniqueId?: string } | undefined;
  toUser?: { id?: string; displayId?: string; uniqueId?: string } | undefined;
  gift?: { id?: string; name?: string; type?: number; diamondCount?: number } | undefined;
  extendedGiftInfo?: { name?: string; diamond_count?: number } | undefined;
}

export type GiftDecision =
  | { kind: 'count'; event: GiftEvent }
  | { kind: 'streak-in-progress'; preview: GiftEvent }
  | { kind: 'ignored'; reason: string };

export function decideGift(msg: RawGiftMessage): GiftDecision {
  const userId = msg.user?.id;
  if (!userId || userId === '0') return { kind: 'ignored', reason: 'evento sem ID de usuário' };

  const giftType = msg.gift?.type ?? 0;
  const repeatEnd = msg.repeatEnd === true || msg.repeatEnd === 1;
  const quantity = Math.max(1, Number(msg.repeatCount) || 1);
  const coinsEach = Number(msg.gift?.diamondCount ?? msg.extendedGiftInfo?.diamond_count ?? 0);
  const giftId = String(msg.gift?.id ?? msg.giftId ?? '');

  const sentAtMs = Number(msg.common?.createTime);
  const sentAt = Number.isFinite(sentAtMs) && sentAtMs > 0 ? new Date(sentAtMs) : new Date();

  const msgId = msg.common?.msgId && msg.common.msgId !== '0' ? msg.common.msgId : null;
  // Sem msgId, monta uma chave estável: mesma pessoa + mesmo grupo de sequência + mesmo presente.
  const eventKey = msgId ?? `${userId}:${msg.groupId ?? '0'}:${giftId}:${quantity}:${sentAt.getTime()}`;

  const event: GiftEvent = {
    eventKey,
    userId,
    uniqueId: msg.user?.displayId || msg.user?.uniqueId || '',
    nickname: msg.user?.nickname || '',
    giftId,
    giftName: msg.gift?.name || msg.extendedGiftInfo?.name || `presente ${giftId}`,
    coinsEach,
    quantity,
    coinsTotal: coinsEach * quantity,
    toUserId: msg.toUser?.id && msg.toUser.id !== '0' ? msg.toUser.id : null,
    toUniqueId: msg.toUser?.displayId || msg.toUser?.uniqueId || null,
    sentAt,
  };

  if (giftType === 1 && !repeatEnd) return { kind: 'streak-in-progress', preview: event };
  if (coinsEach <= 0) return { kind: 'ignored', reason: 'presente sem valor em moedas' };
  return { kind: 'count', event };
}
