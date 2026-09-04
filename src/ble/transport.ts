/**
 * ObdTransport — adaptore giden/gelen ham byte akisinin soyutlamasi.
 *
 * Iki implementasyonu var:
 *   - BleTransport   (src/ble/bleTransport.ts)  gercek adaptor, react-native-ble-plx
 *   - MockTransport   (src/ble/mockTransport.ts) arabasiz gelistirme icin sahte adaptor
 *
 * elm327.ts, poller.ts ve UI bu arayuzden baska bir sey bilmez; hangi transport
 * kullanildigi degistirilebilir olmalidir (dev switch).
 *
 * ONEMLI: send() implementasyonlari ilk satirinda assertReadOnly() cagirmak
 * ZORUNDADIR. Bu arayuzun kendisi bunu zorlayamaz (TypeScript seviyesinde),
 * ama her iki implementasyon da bunu yapar ve testleri bunu dogrular.
 */

export type ObdConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ObdTransport {
  readonly state: ObdConnectionState;

  /** Cihaza baglanir. Zaten baglıysa no-op. */
  connect(): Promise<void>;

  /** Baglantiyi keser. */
  disconnect(): Promise<void>;

  /**
   * Tek bir komut gonderir ve tam cevabi (ELM327 `>` prompt'una kadar,
   * prompt haric) dondurur. Ic ic'e cagrilamaz -- cagiran taraf kuyruklama
   * yapmalidir (bkz. elm327.ts CommandQueue).
   *
   * @throws {ReadOnlyViolationError} komut beyaz listede degilse.
   * @throws {Error} timeout veya baglanti hatasi.
   */
  send(command: string, timeoutMs?: number): Promise<string>;

  /** Baglanti durumu degistiginde cagirilir. */
  onStateChange(listener: (state: ObdConnectionState) => void): () => void;
}
