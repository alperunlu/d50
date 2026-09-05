/**
 * Live ekranındaki kartların görünüm sırası.
 *
 * Saf bir fonksiyon ama ayrı bir dosyada duruyor: store'un içindeyken
 * onu test etmek `react-native-ble-plx`'i de içeri çekiyordu ve Jest
 * bunu dönüştüremiyor. Mantığın kendisi cihazla ilgisiz olduğu için
 * cihaza bağımlı modülden ayrılması doğru olan.
 */

export interface CardOrderInput {
  /** Seçili OBD PID'leri. */
  readonly selectedPids: readonly string[];
  /** Seçili telefon sensörü kanalları. */
  readonly selectedSensorChannels: readonly string[];
  /** Kullanıcının sürükleyerek kurduğu sıra. */
  readonly cardOrder: readonly string[];
}

/**
 * Kaydedilmiş sırayı güncel seçimle birleştirir.
 *
 * İki kural: sırada olup artık seçili olmayanlar DÜŞER, yeni seçilenler
 * SONA eklenir. Böylece bir kanal ekleyip çıkarmak kullanıcının kurduğu
 * düzeni bozmuyor — düzeni her seçim değişikliğinde sıfırlamak, sürükleyip
 * sıralamayı anlamsız kılardı.
 */
export function orderedCards(state: CardOrderInput): string[] {
  const selected = [...state.selectedPids, ...state.selectedSensorChannels];
  const known = state.cardOrder.filter((k) => selected.includes(k));
  const added = selected.filter((k) => !known.includes(k));
  return [...known, ...added];
}

/** Bir kartı `from` konumundan `to` konumuna taşır. */
export function moveInOrder(order: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
