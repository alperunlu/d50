/**
 * Kalıcı künye — her ekranın üstünde.
 *
 * Tasarımın gerekçesi (03 numaralı panelden): kimlik ve bağlantı durumu
 * kalıcı krom içinde durur, böylece Link bir sekme olmaktan çıkıp yalnızca
 * nokta yeşil değilken açtığın bir sayfaya dönüşür. Sürüş sırasında "hâlâ
 * bağlı mıyım, hangi protokoldeyim" için sekme değiştirmek gerekmiyor.
 *
 * NOT: Burada araç modeli YAZMIYOR. Uygulamanın hangi araca takıldığını
 * doğrulama imkânı yok — VIN okumuyoruz (Mode 09 allowlist'te değil) ve
 * OBD-II jenerik katmanı marka bilgisi vermiyor. "MINI Cooper R50" yazmak
 * doğrulanmamış bir varsayımı gerçek gibi göstermek olurdu. Araç tarafına
 * özel olan tek şey arıza kodu tablosu ve o da Faults ekranında açıkça
 * "R50 service data" diye etiketleniyor.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAppStore } from '../state/store';
import { color, type, space, hairlineWidth } from './theme';
import { StatusDot } from './primitives';

/** Sağ üstte bağlantı durumunun altında gösterilecek ikinci satır. */
export type ChromeSubtitle = 'protocol' | 'readonly';

export function VehicleChrome({ subtitle = 'protocol' }: { subtitle?: ChromeSubtitle }) {
  const connectionState = useAppStore((s) => s.connectionState);
  const initResult = useAppStore((s) => s.initResult);

  const linked = connectionState === 'connected';
  const statusText =
    connectionState === 'connected'
      ? 'Linked'
      : connectionState === 'connecting'
        ? 'Linking'
        : connectionState === 'error'
          ? 'Fault'
          : 'Offline';

  const statusTint = linked
    ? color.linked
    : connectionState === 'error'
      ? color.alert
      : connectionState === 'connecting'
        ? color.caution
        : color.muted;

  const second =
    subtitle === 'readonly'
      ? 'Read only · Mode 04 blocked'
      : initResult
        ? protocolName(initResult.protocolNumber)
        : 'No protocol';

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View>
          <Text style={type.vehicle}>D50 SCAN TOOL</Text>
          <Text style={[type.meta, { marginTop: space(1) }]}>{today()}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <StatusDot text={statusText} tint={statusTint} />
          <Text style={[type.metaSmall, { marginTop: space(0.75) }]}>{second}</Text>
        </View>
      </View>
      <View style={styles.rule} />
    </View>
  );
}

/** Bugünün tarihi, yerel ayardan bağımsız sabit biçimde. */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * ELM327 protokol numarasını okunur isme çevirir. R50 K-line kullandığı için
 * beklenen 3/4/5; CAN (6+) çıkarsa varsayımımız yanlış demektir ve bunu
 * ekranda görmek isteriz.
 */
function protocolName(n: string): string {
  const map: Record<string, string> = {
    '1': 'SAE J1850 PWM',
    '2': 'SAE J1850 VPW',
    '3': 'ISO 9141-2',
    '4': 'ISO 14230-4 KWP (5-baud)',
    '5': 'ISO 14230-4 KWP',
    '6': 'ISO 15765-4 CAN 11/500',
    '7': 'ISO 15765-4 CAN 29/500',
    '8': 'ISO 15765-4 CAN 11/250',
    '9': 'ISO 15765-4 CAN 29/250',
    A: 'SAE J1939 CAN',
  };
  const key = n.trim().replace(/^A/i, 'A').toUpperCase();
  return map[key] ?? `Protocol ${n.trim()}`;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space(5), paddingTop: space(2) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  rule: {
    height: hairlineWidth,
    backgroundColor: color.hairline,
    marginTop: space(4),
  },
});
