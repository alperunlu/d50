import React from 'react';
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { theme } from '../src/ui/theme';

function TabIcon({ symbol, color }: { symbol: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color }}>{symbol}</Text>;
}

export default function RootLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textDim,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Connect',
          tabBarIcon: ({ color }) => <TabIcon symbol="🔌" color={color} />,
        }}
      />
      <Tabs.Screen
        name="live"
        options={{
          title: 'Live',
          tabBarIcon: ({ color }) => <TabIcon symbol="📈" color={color} />,
        }}
      />
      <Tabs.Screen
        name="faults"
        options={{
          title: 'Faults',
          tabBarIcon: ({ color }) => <TabIcon symbol="⚠️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color }) => <TabIcon symbol="🗂️" color={color} />,
        }}
      />
      <Tabs.Screen
        name="debug"
        options={{
          title: 'Debug',
          tabBarIcon: ({ color }) => <TabIcon symbol="🛠️" color={color} />,
        }}
      />
    </Tabs>
  );
}
