import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  PanResponder,
  Animated,
  type PanResponderInstance,
  type ViewStyle,
} from 'react-native';
import { color, space, hairlineWidth } from './theme';

/**
 * Live ekranındaki kartları YERİNDE sürükleyip bırakma.
 *
 * Kartlar bulundukları düzende kalıyor — ilk kart tam genişlikte "hero",
 * gerisi iki sütunlu ızgara. Sürükleme ayrı bir ekranda değil, kartın
 * kendisinde başlıyor.
 *
 * TASARIM KARARLARI
 *
 * 1. UZUN BASIŞLA başlıyor (280 ms). Kartlar bir ScrollView içinde;
 *    dokunur dokunmaz sürüklemeye başlasaydık ekranı kaydırmak imkânsız
 *    olurdu. Uzun basış, iOS'ta zaten "bu öğeyi tut" anlamına gelen jest.
 *
 * 2. HEDEF, PARMAĞIN ÜSTÜNDE DURDUĞU KART. Kartlar eşit boyutlu olmadığı
 *    için (hero geniş, hücreler dar) indeksi konumdan hesaplamak yerine
 *    her kartın ekrandaki gerçek dikdörtgeni ölçülüyor.
 *
 * 3. SIRA YALNIZCA BIRAKINCA DEĞİŞİYOR. Sürüklerken düzen sabit kalıyor,
 *    hedef kart yalnızca çerçeveyle işaretleniyor.
 *
 * PANRESPONDER KART BAŞINA BİR KEZ KURULUYOR — bu kritik.
 * Önce her çizimde yeniden kuruluyordu: `hoverKey` değiştikçe bileşen
 * yeniden çiziliyor, jestin ORTASINDA yeni `panHandlers` devreye giriyor
 * ve responder sonlanıyordu. Kullanıcının gördüğü hata tam olarak buydu —
 * parmak hâlâ ekrandayken kart bırakılmış sayılıp yer değiştiriyordu.
 * Artık handler'lar sabit; değişen her şey (kart listesi, callback'ler)
 * `latest` ref'i üzerinden okunuyor.
 *
 * BAĞIMLILIK EKLENMEDİ: PanResponder ve Animated React Native'in içinde.
 * gesture-handler/reanimated getirmek yeni bir native build demekti.
 */

const LONG_PRESS_MS = 280;
/** Tutulan kart hiç KIPIRDAMADAN kalırsa bu süre sonunda bırakılır. */
const STUCK_TIMEOUT_MS = 4000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DragGridProps {
  /** Kart anahtarları, görünüm sırasında. */
  readonly cards: readonly string[];
  /** İlk kart (hero) için içerik. */
  readonly renderHero: (key: string) => React.ReactNode;
  /** Izgara hücresi içeriği. */
  readonly renderCell: (key: string) => React.ReactNode;
  readonly onReorder: (from: number, to: number) => void;
  /** Sürükleme sırasında ScrollView'ı kilitlemek için. */
  readonly onDragStateChange?: (dragging: boolean) => void;
}

export function DragGrid({
  cards,
  renderHero,
  renderCell,
  onReorder,
  onDragStateChange,
}: DragGridProps) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const viewRefs = useRef<Record<string, View | null>>({});
  const rects = useRef<Record<string, Rect>>({});
  const dragKeyRef = useRef<string | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const movedRef = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Sabit handler'ların güncel değerlere ulaşması için: responder bir kez
   * kuruluyor ama her jestte en son kart listesini ve callback'i görmeli.
   */
  const latest = useRef({ cards, onReorder, onDragStateChange });
  latest.current = { cards, onReorder, onDragStateChange };

  const clearTimers = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (stuckTimer.current) {
      clearTimeout(stuckTimer.current);
      stuckTimer.current = null;
    }
  }, []);

  /** Sürükleme başlarken bütün kartların ekrandaki yerini ölçer. */
  const measureAll = useCallback(() => {
    for (const key of latest.current.cards) {
      const node = viewRefs.current[key];
      if (!node) continue;
      node.measureInWindow((x, y, width, height) => {
        rects.current[key] = { x, y, width, height };
      });
    }
  }, []);

  const keyAt = useCallback((pageX: number, pageY: number): string | null => {
    for (const [key, r] of Object.entries(rects.current)) {
      if (pageX >= r.x && pageX <= r.x + r.width && pageY >= r.y && pageY <= r.y + r.height) {
        return key;
      }
    }
    return null;
  }, []);

  const endDragRef = useRef<(apply: boolean) => void>(() => {});

  const beginDrag = useCallback(
    (key: string) => {
      movedRef.current = false;
      measureAll();
      pan.setValue({ x: 0, y: 0 });
      dragKeyRef.current = key;
      setDragKey(key);
      latest.current.onDragStateChange?.(true);

      /**
       * Emniyet: kart tutulup hiç KIPIRDATILMADAN bırakılırsa (dokunma-bitti
       * olayı kaçarsa) sonsuza kadar tutuluyor görünmesin. Hareket başladıysa
       * iptal ediliyor — sürüklemenin ortasında kesmesi kabul edilemez.
       */
      stuckTimer.current = setTimeout(() => {
        if (dragKeyRef.current === key && !movedRef.current) endDragRef.current(false);
      }, STUCK_TIMEOUT_MS);
    },
    [measureAll, pan],
  );

  /** Sürüklemeyi bitirir; `apply` false ise sıra değiştirilmez. */
  const endDrag = useCallback(
    (apply: boolean) => {
      const from = dragKeyRef.current;
      const to = hoverKeyRef.current;

      clearTimers();
      dragKeyRef.current = null;
      hoverKeyRef.current = null;
      movedRef.current = false;
      setDragKey(null);
      setHoverKey(null);
      pan.setValue({ x: 0, y: 0 });
      latest.current.onDragStateChange?.(false);

      if (!apply || !from || !to || from === to) return;
      const list = latest.current.cards;
      const fromIndex = list.indexOf(from);
      const toIndex = list.indexOf(to);
      if (fromIndex >= 0 && toIndex >= 0) latest.current.onReorder(fromIndex, toIndex);
    },
    [clearTimers, pan],
  );

  endDragRef.current = endDrag;

  /**
   * Kart başına TEK PanResponder. `useMemo` yalnızca kart listesi
   * değiştiğinde yeniden kuruyor; jest sırasında liste değişmediği için
   * handler'lar sabit kalıyor ve responder yarıda kesilmiyor.
   */
  const responders = useMemo(() => {
    const map: Record<string, PanResponderInstance> = {};

    for (const key of cards) {
      map[key] = PanResponder.create({
        /**
         * Dokunuş HEMEN kapılmıyor: sayaç başlatılıp `false` dönülüyor,
         * böylece ScrollView kaydırmayı sürdürebiliyor. Sürükleme ancak
         * uzun basış dolunca devralınıyor.
         */
        onStartShouldSetPanResponderCapture: () => {
          clearTimers();
          longPressTimer.current = setTimeout(() => beginDrag(key), LONG_PRESS_MS);
          return false;
        },

        /** Uzun basış dolmadan kaydırma başladıysa sürükleme niyeti yoktur. */
        onMoveShouldSetPanResponderCapture: (_evt, gesture) => {
          if (dragKeyRef.current !== key && Math.abs(gesture.dy) + Math.abs(gesture.dx) > 6) {
            clearTimers();
          }
          return false;
        },

        onMoveShouldSetPanResponder: () => dragKeyRef.current === key,
        /** Sürükleme başladıktan sonra ScrollView jesti geri alamasın. */
        onPanResponderTerminationRequest: () => false,

        onPanResponderMove: (evt, gesture) => {
          movedRef.current = true;
          pan.setValue({ x: gesture.dx, y: gesture.dy });

          const target = keyAt(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
          // Yalnızca hedef DEĞİŞTİĞİNDE yeniden çiziliyor: her parmak
          // hareketinde state güncellemek sürüklemeyi takılmalı yapardı.
          if (target !== hoverKeyRef.current) {
            hoverKeyRef.current = target;
            setHoverKey(target);
          }
        },

        onPanResponderRelease: () => endDragRef.current(true),
        onPanResponderTerminate: () => endDragRef.current(false),
      });
    }

    return map;
  }, [beginDrag, cards, clearTimers, keyAt, pan]);

  const cardProps = (key: string) => ({
    ref: (node: View | null) => {
      viewRefs.current[key] = node;
    },
    onTouchEnd: () => {
      // Uzun basış dolmadan parmak kalktıysa sürükleme hiç başlamamalı.
      if (dragKeyRef.current === null) clearTimers();
    },
    onTouchCancel: () => clearTimers(),
    ...responders[key].panHandlers,
  });

  const styleFor = (key: string): ViewStyle[] => {
    const out: ViewStyle[] = [];
    if (dragKey === key) out.push(styles.dragging);
    else if (hoverKey === key && dragKey !== null) out.push(styles.hovered);
    return out;
  };

  const animatedFor = (key: string) =>
    dragKey === key ? { transform: pan.getTranslateTransform(), zIndex: 10, opacity: 0.9 } : null;

  const [hero, ...cells] = cards;

  return (
    <>
      {hero ? (
        <Animated.View style={[styleFor(hero), animatedFor(hero)]} {...cardProps(hero)}>
          {renderHero(hero)}
        </Animated.View>
      ) : null}

      <View style={styles.grid}>
        {cells.map((key) => (
          <Animated.View
            key={key}
            style={[styles.cellWrap, styleFor(key), animatedFor(key)]}
            {...cardProps(key)}
          >
            {renderCell(key)}
          </Animated.View>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: space(3.5),
  },
  cellWrap: { width: '48.5%' },
  /** Tutulan kart: hafifçe yükselmiş görünüyor. */
  dragging: {
    backgroundColor: color.groundAlt,
    borderWidth: hairlineWidth,
    borderColor: color.hairlineStrong,
  },
  /** Bırakılacak yer: parmağın üstünde durduğu kart. */
  hovered: {
    borderWidth: hairlineWidth,
    borderColor: color.linked,
  },
});
