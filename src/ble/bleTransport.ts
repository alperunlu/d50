/**
 * Gerçek Vgate iCar Pro (BLE) bağlantısı — react-native-ble-plx üzerine.
 *
 * Salt-okunurluk garantisi: send() ilk satırda assertReadOnly() çağırır.
 * Bundan geçmeyen hiçbir bayt writeCharacteristic*() çağrısına ulaşmaz —
 * bu dosyadaki TEK yazma noktası `writeToCharacteristic()` metodudur ve o
 * da yalnızca `send()` tarafından, yalnızca doğrulanmış komutla çağrılır.
 *
 * UUID'ler sabit yazılmaz (bkz. plan, Kısıt #0): `profiles.ts` denenmeye
 * değer profilleri SIRALI döner ve connect() her birini gerçek bir komutla
 * (ATI) sınar — abonelik kurulabiliyor ama adaptör cevap vermiyorsa sıradaki
 * profile geçilir. Arabaya her gidiş pahalı olduğu için tek denemede
 * pes edilmiyor. Hiçbiri tutmazsa `lastCandidates` ham listesi UI'ye sunulur.
 */

import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import type { ObdConnectionState, ObdTransport } from './transport';
import { assertReadOnly } from '../obd/allowlist';
import { ResponseFramer } from '../obd/elm327';
import { discoverProfiles, type DiscoveredProfile, type ProfileCandidate } from './profiles';
import { decodeBase64ToAscii, encodeAsciiToBase64 } from '../util/base64';

export interface ScannedDevice {
  readonly id: string;
  readonly name: string | null;
  readonly rssi: number | null;
}

interface PendingRequest {
  readonly resolve: (response: string) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Profil sınama komutunun timeout'u — ATI adaptöre gider, hızlı cevaplanır. */
const PROBE_TIMEOUT_MS = 3000;

export class BleTransport implements ObdTransport {
  private readonly manager: BleManager;
  state: ObdConnectionState = 'disconnected';
  private listeners = new Set<(s: ObdConnectionState) => void>();
  private logListeners = new Set<(msg: string) => void>();

  private targetDeviceId: string | null = null;
  private device: Device | null = null;
  private profile: DiscoveredProfile | null = null;
  private notifySub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;

  private readonly framer = new ResponseFramer();
  private pending: PendingRequest | null = null;

  /** Son keşifte bulunan ham servis/karakteristik listesi (profil eşleşmediyse UI'ye sunulur). */
  lastCandidates: readonly ProfileCandidate[] = [];

  constructor(manager?: BleManager) {
    this.manager = manager ?? new BleManager();
  }

  /** UI'nin tarama listesinden bir adaptör göstermesi/seçmesi için. */
  scan(onDevice: (d: ScannedDevice) => void, onError?: (err: Error) => void): () => void {
    this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        onError?.(new Error(error.message));
        return;
      }
      if (device) {
        onDevice({ id: device.id, name: device.name ?? device.localName ?? null, rssi: device.rssi });
      }
    });
    return () => {
      this.manager.stopDeviceScan();
    };
  }

  /** Bağlanılacak cihazı önceden seçer. connect() bunu kullanır. */
  setTargetDevice(deviceId: string): void {
    this.targetDeviceId = deviceId;
  }

  get discoveredProfile(): DiscoveredProfile | null {
    return this.profile;
  }

  /**
   * Bağlanma sürecindeki ara adımları (hangi profil deneniyor, neden
   * başarısız oldu) debug log'una taşır. Bu olaylar transport'un İÇİNDE
   * gerçekleştiği için store'un dıştan saran logger'ı bunları göremez.
   */
  onLog(listener: (msg: string) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  private log(msg: string): void {
    for (const l of this.logListeners) l(msg);
  }

  private setState(s: ObdConnectionState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  onStateChange(listener: (s: ObdConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    if (!this.targetDeviceId) {
      throw new Error('BleTransport: no target device selected (setTargetDevice must be called)');
    }

    this.setState('connecting');
    try {
      await this.manager.stopDeviceScan();

      const device = await this.manager.connectToDevice(this.targetDeviceId, { autoConnect: false });
      this.device = device;

      this.disconnectSub = this.manager.onDeviceDisconnected(device.id, () => {
        this.handleDisconnect();
      });

      const { profiles, candidates } = await discoverProfiles(device);
      this.lastCandidates = candidates;

      if (profiles.length === 0) {
        throw new Error(
          'No suitable GATT profile found. Pick a notify + write pair manually from the list on the Debug screen.',
        );
      }

      // Profilleri sırayla dene; her birini gerçek bir komutla sına.
      let lastError: Error | null = null;
      for (const profile of profiles) {
        this.log(`Trying profile: ${profile.label}`);
        try {
          this.subscribeToNotifications(device, profile);
          const reply = await this.send('ATI', PROBE_TIMEOUT_MS);
          this.log(`Profile works: ${profile.label} (ATI → ${reply.trim().replace(/\r/g, ' ')})`);
          this.setState('connected');
          return;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          this.log(`Profile failed: ${profile.label} — ${lastError.message}`);
          this.teardownNotifications();
        }
      }

      throw new Error(
        `None of the ${profiles.length} GATT profiles worked. Last error: ${lastError?.message ?? 'unknown'}. ` +
          'You can pick a notify + write pair manually from the list on the Debug screen.',
      );
    } catch (e) {
      this.setState('error');
      throw e;
    }
  }

  /**
   * Otomatik keşfin bulduğu profillerin hiçbiri çalışmadığında, kullanıcının
   * debug ekranındaki ham listeden elle seçtiği notify/write çiftiyle
   * bağlanmayı dener. Cihaz zaten bağlı (connect() bunu kurdu) — burada
   * yeniden connectToDevice() ÇAĞRILMAZ, sadece abonelik kurulur.
   */
  async connectWithManualProfile(profile: DiscoveredProfile): Promise<void> {
    if (!this.device) {
      throw new Error('BleTransport: connect() must be called first');
    }
    try {
      this.log(`Trying manual profile: ${profile.serviceUUID} / n:${profile.notifyUUID} w:${profile.writeUUID}`);
      this.subscribeToNotifications(this.device, profile);
      const reply = await this.send('ATI', PROBE_TIMEOUT_MS);
      this.log(`Manual profile works (ATI → ${reply.trim().replace(/\r/g, ' ')})`);
      this.setState('connected');
    } catch (e) {
      this.teardownNotifications();
      this.setState('error');
      throw e;
    }
  }

  /**
   * Bildirim aboneliğini kurar. Önceki aboneliği MUTLAKA kapatır — aksi hâlde
   * başarısız bir profilin ölü aboneliği hayatta kalır ve sonraki profilin
   * bekleyen komutunu hatayla düşürür.
   */
  private subscribeToNotifications(device: Device, profile: DiscoveredProfile): void {
    this.teardownNotifications();
    this.profile = profile;
    this.framer.reset();

    this.notifySub = device.monitorCharacteristicForService(
      profile.serviceUUID,
      profile.notifyUUID,
      (error, characteristic) => {
        if (error) {
          // Abonelik reddedildi ya da koptu: bekleyen komutu düşür. Durum
          // güncellemesi çağırana ait — bağlanma sırasında sıradaki profil
          // denenecek, bağlantı kurulduktan sonraysa gerçek bir kopmadır.
          this.failPending(new Error(`Notification error: ${error.message}`));
          if (this.state === 'connected') {
            this.setState('error');
          }
          return;
        }
        if (!characteristic?.value) return;
        const chunk = decodeBase64ToAscii(characteristic.value);
        const complete = this.framer.push(chunk);
        if (complete !== null) {
          this.resolvePending(complete);
        }
      },
    );
  }

  private teardownNotifications(): void {
    this.notifySub?.remove();
    this.notifySub = null;
    this.profile = null;
    this.framer.reset();
  }

  async disconnect(): Promise<void> {
    this.teardownNotifications();
    this.disconnectSub?.remove();
    this.disconnectSub = null;

    if (this.device) {
      try {
        await this.manager.cancelDeviceConnection(this.device.id);
      } catch {
        // Zaten kopmuşsa hata verir, önemli değil.
      }
    }

    this.device = null;
    this.failPending(new Error('Disconnected'));
    this.setState('disconnected');
  }

  private handleDisconnect(): void {
    this.teardownNotifications();
    this.device = null;
    this.failPending(new Error('Adapter connection dropped unexpectedly'));
    this.setState('disconnected');
  }

  async send(rawCommand: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    // ★ Tek geçit — bkz. dosya başındaki not.
    const cmd = assertReadOnly(rawCommand);

    if (!this.device || !this.profile) {
      throw new Error('BleTransport: not connected');
    }
    if (this.pending) {
      throw new Error('BleTransport: a previous command is still pending (CommandQueue should have prevented this)');
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Command "${cmd}" was not answered within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending = { resolve, reject, timer };

      this.writeToCharacteristic(cmd + '\r').catch((e: unknown) => {
        this.failPending(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /**
   * Adaptöre doğrudan yazan TEK metot. `send()` dışında hiçbir yerden
   * çağrılmaz ve `send()` her zaman `assertReadOnly()`'den geçmiş bir
   * komutla çağırır.
   */
  private async writeToCharacteristic(text: string): Promise<void> {
    if (!this.device || !this.profile) return;
    const valueBase64 = encodeAsciiToBase64(text);
    if (this.profile.writeWithResponse) {
      await this.device.writeCharacteristicWithResponseForService(
        this.profile.serviceUUID,
        this.profile.writeUUID,
        valueBase64,
      );
    } else {
      await this.device.writeCharacteristicWithoutResponseForService(
        this.profile.serviceUUID,
        this.profile.writeUUID,
        valueBase64,
      );
    }
  }

  private resolvePending(response: string): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { resolve } = this.pending;
    this.pending = null;
    resolve(response);
  }

  private failPending(err: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { reject } = this.pending;
    this.pending = null;
    reject(err);
  }

  /** Uygulama kapanırken kaynakları serbest bırakmak için. */
  destroy(): void {
    this.notifySub?.remove();
    this.disconnectSub?.remove();
    this.manager.destroy();
  }
}
