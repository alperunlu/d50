import React, { useEffect } from 'react';
import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  useFonts,
  BarlowCondensed_500Medium,
  BarlowCondensed_600SemiBold,
} from '@expo-google-fonts/barlow-condensed';
import { Barlow_400Regular } from '@expo-google-fonts/barlow';
import { useAppStore } from '../src/state/store';
import { installCrashLogger, breadcrumb } from '../src/util/crashLog';
import { color, type, space, hairlineWidth } from '../src/ui/theme';

/**
 * Sekme ikonları — tasarımdaki lucide çizgi setinin birebir path'leri.
 * Emoji yerine 1.5 stroke çizgi kullanılıyor: emoji bu dilde tek renkli
 * olmayan tek şey olurdu ve renk disiplinini kırardı.
 */
const ICONS: Record<string, string[]> = {
  index: ['M12 22v-5', 'M9 8V2', 'M15 8V2', 'M18 8v3a6 6 0 0 1-12 0V8z'],
  live: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  faults: [
    'm10.29 3.86-8.19 14A2 2 0 0 0 3.83 21h16.34a2 2 0 0 0 1.73-3.14l-8.19-14a2 2 0 0 0-3.42 0Z',
    'M12 9v4',
    'M12 17h.01',
  ],
  sessions: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
  debug: ['m4 17 6-6-6-6', 'M12 19h8'],
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const stroke = focused ? color.ink : color.muted;
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
      {ICONS[name]?.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/** Arıza varsa Faults sekmesinde kırmızı nokta — kırmızının izinli iki yerinden biri. */
function FaultBadge() {
  const milOn = useAppStore((s) => s.milStatus?.milOn ?? false);
  const stored = useAppStore((s) => s.dtcGroups?.stored.length ?? 0);
  if (!milOn && stored === 0) return null;
  return <View style={styles.badge} />;
}

function TabLabel({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text
      style={[
        type.status,
        { fontSize: 11, letterSpacing: 1.1, color: focused ? color.ink : color.muted },
      ]}
    >
      {label}
    </Text>
  );
}

/**
 * Kanca ekran ağacından ÖNCE, modül yüklenirken kuruluyor: render sırasında
 * atılan bir hata da yakalansın diye.
 */
installCrashLogger();
breadcrumb('app launched');

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    BarlowCondensed_500Medium,
    BarlowCondensed_600SemiBold,
    Barlow_400Regular,
  });

  // Kalıcı ayarlar (takılı lastik ebadı) açılışta bir kez yükleniyor.
  const loadSettings = useAppStore((s) => s.loadSettings);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Fontlar yüklenene kadar zemin rengini gösteriyoruz — sistem fontuyla bir
  // kare çizip sonra Barlow'a atlamak göze çarpan bir sıçrama yaratıyordu.
  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: color.ground }} />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.ground },
        tabBarStyle: {
          backgroundColor: color.ground,
          borderTopWidth: hairlineWidth,
          borderTopColor: color.hairlineStrong,
          height: 78,
          paddingTop: space(2.5),
        },
        tabBarItemStyle: { gap: space(1) },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="index" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Link" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="live"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="live" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Live" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="faults"
        options={{
          tabBarIcon: ({ focused }) => (
            <View>
              <TabIcon name="faults" focused={focused} />
              <FaultBadge />
            </View>
          ),
          tabBarLabel: ({ focused }) => <TabLabel label="Faults" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="sessions" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Trips" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="debug"
        options={{
          tabBarIcon: ({ focused }) => <TabIcon name="debug" focused={focused} />,
          tabBarLabel: ({ focused }) => <TabLabel label="Debug" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -2,
    right: -6,
    width: 6,
    height: 6,
    backgroundColor: color.alert,
  },
});
