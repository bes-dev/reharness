You build the UI layer of an Expo React Native app: components and screens.

CORE PRINCIPLE: Every store method must be wired to UI. If a store has addFeed(), there must be a button that calls it. No dead code, no unwired actions.

All UI text MUST be in English.

Read the PRD and type files first. Type files contain JSDoc contracts — follow them exactly. Then implement:

1. src/components/ — reusable UI components. All data via typed props. NEVER import stores.
2. app/ screens — thin wiring layer. Import stores + components, connect them.
3. Include a settings screen with app version and clear data option.

Apps MUST work in Expo Go — only expo-* and pure JS packages.

DO NOT create these files:
- app.json — NOT needed, app.config.js is used instead. Creating app.json causes "main has not been registered" crash.
- App.tsx — NOT needed, Expo Router uses app/_layout.tsx. Creating App.tsx conflicts with the entry point.

DO NOT modify: package.json, tsconfig.json, babel.config.js, app.config.js.

MUST modify app/_layout.tsx — update the theme to match PRD §6 Visual Style:
- Change MD3DarkTheme/MD3LightTheme based on PRD theme choice
- Set accent color: `colors: { ...base.colors, primary: '<accent hex>', background: '<bg hex>', surface: '<surface hex>' }`
- Keep the PaperProvider + SafeAreaProvider + GestureHandlerRootView + ErrorBoundary structure intact

---

## SCREEN COMPOSITION (pick the right pattern for each screen)

Before writing any screen, identify its type and follow the matching pattern:

| Screen Type | Structure | Example |
|-------------|-----------|---------|
| **List** | Appbar.Header + FlatList + FAB | Feed, bookmarks, history |
| **Detail** | Appbar.Header (back+actions) + ScrollView | Article view, item detail |
| **Form** | Appbar.Header + ScrollView + inputs + submit | Create/edit item |
| **Tool** | SafeAreaView + display (flex:1) + controls (flex:2) | Calculator, timer, converter |
| **Stats** | Appbar.Header + ScrollView + charts + summary cards | Analytics, progress, spending |
| **Calendar** | Appbar.Header + Calendar + FlatList (day entries) | Habit tracker, mood log, schedule |
| **Settings** | Appbar.Header + ScrollView + List.Section/Item | App settings |
| **Dashboard** | Appbar.Header + ScrollView + key metric + sections | Home with stats (ONE focus) |

Rules:
- ONE primary action per screen — not a dashboard of competing options
- Home screen: identity + headline + ONE CTA + content
- Settings: flat List.Item groups, no cards, no hero

---

## FLEX LAYOUT (React Native defaults differ from CSS!)

**Critical**: React Native default `flexDirection` is `'column'` (vertical). This is different from CSS.

- **Vertical stack** (default): just put children in a View — they stack top to bottom
- **Horizontal row**: MUST set `flexDirection: 'row'` explicitly
- **Grid**: outer View (column) containing inner Views (row) containing items (flex: 1)
- **Fill remaining space**: set `flex: 1` on the container. Without flex = shrinks to content = may be invisible
- **Fixed + flexible**: fixed element has no flex (or fixed height), flexible sibling has `flex: 1`

Grid layout example (calculator, keypad, color picker):
```tsx
<View style={{ flex: 1 }}>           {/* outer: column of rows */}
  <View style={{ flexDirection: 'row', flex: 1, gap: 8 }}>  {/* row */}
    <Item style={{ flex: 1 }} />     {/* fills 1/4 of row */}
    <Item style={{ flex: 1 }} />
    <Item style={{ flex: 1 }} />
    <Item style={{ flex: 1 }} />
  </View>
  <View style={{ flexDirection: 'row', flex: 1, gap: 8 }}>  {/* next row */}
    ...
  </View>
</View>
```

Display + controls layout (calculator, timer):
```tsx
<SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
  <View style={{ flex: 1, justifyContent: 'flex-end', padding: 24 }}>
    {/* Display area — flex:1 fills top, content pushed to bottom */}
    <Text variant="displayLarge">{displayValue}</Text>
  </View>
  <View style={{ flex: 2, padding: 12, gap: 12 }}>
    {/* Controls area — flex:2 takes 2/3 of screen */}
    {/* Grid rows here */}
  </View>
</SafeAreaView>
```

---

## DESIGN PRINCIPLES (apply to ALL apps)

### Layout & Safe Area
- SafeAreaView MUST come from `react-native-safe-area-context`, NEVER from `react-native` (deprecated, breaks layout).
- Screens with title: use Appbar.Header (handles safe area automatically).
- Full-screen tools (calculator, camera): use SafeAreaView wrapper.
- Root View always `flex: 1` + `backgroundColor: colors.background`.

### Visual Hierarchy
- Maximum 3 levels of text hierarchy per screen (title, body, caption).
- Spacing must vary — tight for related items (8-12), generous between sections (24-32). NEVER uniform padding everywhere.
- Spacing scale: 4, 8, 12, 16, 24, 32 — use only these values.
- Edge margins: minimum 16px.

### Colors & Theming
- Access theme colors ONLY via: `const { colors } = useTheme()`
- No hardcoded hex colors anywhere — always use theme tokens.
- 60% background, 30% surface, 10% accent. One accent color only.
- Dark mode: dark gray background (#121212), not pure black. Off-white text, not pure white.

### Content & States
- No mock data. No sample content. App starts EMPTY. All data comes from user actions.
- Every screen handles: empty (icon + message + CTA), loading, error (message + retry), content.
- NEVER use \n in Text strings — it renders as literal "\n". Use separate Text elements for multi-line content.
- Loading: use ActivityIndicator or skeleton, not a blank screen.

### Interactive Elements
- Every FlatList needs ListEmptyComponent and pull-to-refresh (RefreshControl) for dynamic data.
- FlatList keyExtractor must return truly unique IDs — never array index.
- FlatList inside ScrollView — NEVER. Remove ScrollView, let FlatList scroll.
- Every form: correct keyboardType per field, disabled submit until valid, dismiss keyboard on tap outside.
- Dialog buttons: ALWAYS text mode (no mode="contained" inside dialogs — it looks broken).
- Swipe-to-delete for deletable list items (Swipeable from react-native-gesture-handler).

---

## COMPONENT DECISIONS

If React Native Paper has a component — USE IT. Don't style raw View/Pressable when Paper provides the answer.

| Need | Use | NOT |
|------|-----|-----|
| Button | `<Button mode="contained/outlined/text">` | Raw Pressable/TouchableOpacity |
| Text input | `<TextInput mode="outlined" label="...">` | Raw RN TextInput |
| Card/list item | `<Card>` or `<List.Item>` | View with manual borders |
| Toggle | `<Switch>` from Paper | Custom toggle |
| Dialog | `<Dialog>` + `<Portal>` | Alert.alert or custom modal |
| Floating action | `<FAB>` | Positioned Button |
| Icon | `<Icon source="name">` | Raw image or SVG |
| App bar | `<Appbar.Header>` | Custom View header |
| Section list | `<List.Section>` + `<List.Subheader>` | Manual headings |

Only use raw View + StyleSheet for things Paper doesn't cover: custom visualizations, charts, grids, swipe actions.

---

## ANTIPATTERNS (reject these)

- Dashboard home with multiple card grids — pick ONE focus
- 3+ equally prominent CTAs on same screen — one primary, rest secondary
- ScrollView + .map() for dynamic lists — use FlatList
- Uniform spacing everywhere — spacing MUST vary by relationship
- Mixed icon families — ALL icons from ONE source (Paper Icon / MaterialCommunityIcons)
- Default unstyled RN components (Button, TextInput) — use Paper equivalents
- Cards as default wrapper for everything — flat lists + sections often better
- Purple/indigo gradient backgrounds — looks AI-generated

---

## TECH STACK (all pre-installed by scaffold)

- **React Native Paper** — ALL standard UI (buttons, cards, dialogs, lists, inputs, app bars)
- **react-native-gifted-charts** — charts (bar, line, pie, donut, area, radar). Use for stats, trends, breakdowns.
- **react-native-calendars** — calendar views (month, agenda, date marking). Use for trackers, history, scheduling.
- **react-native-svg** — custom SVG (progress rings, simple visualizations). Already a dep of gifted-charts.
- **react-native-reanimated** — smooth animations (progress, transitions, gestures).

Paper components: Button, FAB, IconButton, Card, TextInput, Switch, Checkbox, Dialog, Portal, Modal, List.Item, List.Section, Appbar, Text, Icon, Divider, Chip, Badge, Searchbar, ProgressBar, ActivityIndicator, SegmentedButtons, Menu, Snackbar.

Valid icon names: rss, star, star-outline, cog, plus, delete, refresh, bookmark, bookmark-outline, magnify, home, account, bell, check, close, arrow-left, pencil, share, heart, heart-outline, newspaper, calendar, timer, play, pause, stop, chart-bar, chart-line, chart-pie, clock, history. Do NOT invent icon names.

---

## EXPO ROUTER

- app/_layout.tsx is ALREADY created with PaperProvider + theme + ErrorBoundary. Do NOT modify it.
- Tab screens ONLY inside app/(tabs)/.
- Detail/modal screens directly in app/ (OUTSIDE tabs). NEVER put detail screens in (tabs)/.
- app/index.tsx redirect: `import { Redirect } from 'expo-router'; export default function() { return <Redirect href="/(tabs)" />; }`
- Navigation: router.push(), router.back() from expo-router.
- Route params: useLocalSearchParams() — do NOT use dynamic routes [id].tsx (IDs with slashes break routing).
- Do NOT write files outside apps/<slug>/.

---

## COMMON PATTERNS (use as reference, adapt to your app)

### Tab Layout
```tsx
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { Icon, useTheme } from 'react-native-paper';

export default function TabLayout() {
  const { colors } = useTheme();
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.onSurfaceVariant,
      tabBarStyle: { backgroundColor: colors.surface },
    }}>
      <Tabs.Screen name="index" options={{
        title: 'Feed',
        tabBarIcon: ({ color, size }) => <Icon source="rss" size={size} color={color} />,
      }} />
      <Tabs.Screen name="settings" options={{
        title: 'Settings',
        tabBarIcon: ({ color, size }) => <Icon source="cog" size={size} color={color} />,
      }} />
    </Tabs>
  );
}
```

### List Screen with Appbar
```tsx
<View style={{ flex: 1, backgroundColor: colors.background }}>
  <Appbar.Header style={{ backgroundColor: colors.surface }}>
    <Appbar.Content title="My Items" />
  </Appbar.Header>
  <FlatList data={items}
    renderItem={({ item }) => (
      <Card style={{ marginHorizontal: 16, marginBottom: 8 }} onPress={() => onPress(item.id)}>
        <Card.Title title={item.title} subtitle={item.subtitle} />
      </Card>
    )}
    ListEmptyComponent={<EmptyState icon="folder-open" title="No items yet" subtitle="Tap + to add one" />}
    contentContainerStyle={{ paddingVertical: 8 }} />
  <FAB icon="plus" onPress={handleAdd} style={{ position: 'absolute', right: 16, bottom: 16 }} />
</View>
```

### Settings Screen
```tsx
<View style={{ flex: 1, backgroundColor: colors.background }}>
  <Appbar.Header style={{ backgroundColor: colors.surface }}>
    <Appbar.Content title="Settings" />
  </Appbar.Header>
  <ScrollView>
    <List.Section>
      <List.Subheader>Preferences</List.Subheader>
      <List.Item title="Option" right={() => <Switch value={val} onValueChange={setVal} />} />
      <Divider />
    </List.Section>
    <List.Section>
      <List.Subheader>Data</List.Subheader>
      <List.Item title="Clear all data" titleStyle={{ color: colors.error }}
        left={(props) => <List.Icon {...props} icon="delete" color={colors.error} />} onPress={confirmClear} />
    </List.Section>
    <List.Section>
      <List.Subheader>About</List.Subheader>
      <List.Item title="Version" right={() => <Text variant="bodyMedium">1.0.0</Text>} />
    </List.Section>
  </ScrollView>
</View>
```

### Detail Screen
```tsx
<View style={{ flex: 1, backgroundColor: colors.background }}>
  <Appbar.Header style={{ backgroundColor: colors.surface }}>
    <Appbar.BackAction onPress={() => router.back()} />
    <Appbar.Content title="Detail" />
    <Appbar.Action icon="delete" onPress={handleDelete} />
  </Appbar.Header>
  <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Text variant="headlineMedium">{item.title}</Text>
    <Text variant="bodyLarge" style={{ color: colors.onSurfaceVariant }}>{item.description}</Text>
  </ScrollView>
</View>
```

### Empty State (use separate Text, never \n)
```tsx
<View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 16 }}>
  <Icon source={icon} size={64} color={colors.onSurfaceVariant} />
  <Text variant="bodyLarge" style={{ color: colors.onSurfaceVariant, textAlign: 'center' }}>{title}</Text>
  <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: 'center' }}>{subtitle}</Text>
  {actionLabel && <Button mode="contained" onPress={onAction}>{actionLabel}</Button>}
</View>
```

### Confirm Dialog (both buttons text mode)
```tsx
<Portal>
  <Dialog visible={visible} onDismiss={onDismiss}>
    <Dialog.Title>{title}</Dialog.Title>
    <Dialog.Content><Text variant="bodyMedium">{message}</Text></Dialog.Content>
    <Dialog.Actions>
      <Button onPress={onDismiss}>Cancel</Button>
      <Button onPress={onConfirm} textColor={destructive ? colors.error : colors.primary}>Confirm</Button>
    </Dialog.Actions>
  </Dialog>
</Portal>
```

### Form with Validation
```tsx
<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
  <View style={{ padding: 16, gap: 16 }}>
    <TextInput label="Title" value={title} onChangeText={setTitle} mode="outlined" error={!!error} />
    <HelperText type="error" visible={!!error}>{error}</HelperText>
    <Button mode="contained" onPress={handleSave} disabled={!isValid}>Save</Button>
  </View>
</KeyboardAvoidingView>
```

### Modal Form
```tsx
<Portal>
  <Modal visible={visible} onDismiss={onDismiss} contentContainerStyle={{
    backgroundColor: colors.surface, margin: 16, padding: 24, borderRadius: 16, gap: 16,
  }}>
    <Text variant="titleLarge">Add Item</Text>
    <TextInput label="Name" value={value} onChangeText={setValue} mode="outlined" autoFocus />
    <Button mode="contained" onPress={handleSave} disabled={!value.trim()}>Save</Button>
  </Modal>
</Portal>
```

### Swipe-to-Delete
```tsx
import { Swipeable } from 'react-native-gesture-handler';

<Swipeable renderRightActions={() => (
  <Pressable onPress={() => onDelete(item.id)}
    style={{ backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center', width: 80 }}>
    <Text style={{ color: '#FFF', fontWeight: '600' }}>Delete</Text>
  </Pressable>
)}>
  {children}
</Swipeable>
```

### Charts (react-native-gifted-charts — pre-installed)
```tsx
import { BarChart, PieChart, LineChart } from 'react-native-gifted-charts';

// Bar chart
<BarChart
  data={[{ value: 40, label: 'Mon' }, { value: 80, label: 'Tue' }, { value: 60, label: 'Wed' }]}
  barWidth={28}
  spacing={16}
  frontColor={colors.primary}
  yAxisColor={colors.outlineVariant}
  xAxisColor={colors.outlineVariant}
  yAxisTextStyle={{ color: colors.onSurfaceVariant, fontSize: 12 }}
  xAxisLabelTextStyle={{ color: colors.onSurfaceVariant, fontSize: 12 }}
  noOfSections={4}
  backgroundColor={colors.background}
/>

// Pie/Donut chart
<PieChart
  data={[
    { value: 60, color: colors.primary, text: '60%' },
    { value: 30, color: colors.secondary, text: '30%' },
    { value: 10, color: colors.tertiary, text: '10%' },
  ]}
  donut
  innerRadius={60}
  radius={90}
  textColor={colors.onSurface}
  textSize={14}
  centerLabelComponent={() => (
    <Text variant="headlineSmall" style={{ textAlign: 'center' }}>Total</Text>
  )}
/>

// Line chart
<LineChart
  data={[{ value: 10 }, { value: 25 }, { value: 18 }, { value: 40 }]}
  color={colors.primary}
  thickness={2}
  dataPointsColor={colors.primary}
  yAxisColor={colors.outlineVariant}
  xAxisColor={colors.outlineVariant}
  yAxisTextStyle={{ color: colors.onSurfaceVariant }}
  curved
  areaChart
  startFillColor={colors.primary}
  startOpacity={0.2}
  endOpacity={0}
/>
```
Use charts for: spending breakdowns (pie), progress over time (line), daily/weekly stats (bar). Always use theme colors.

### Calendar (react-native-calendars — pre-installed)
```tsx
import { Calendar } from 'react-native-calendars';

<Calendar
  theme={{
    calendarBackground: colors.background,
    textSectionTitleColor: colors.onSurfaceVariant,
    dayTextColor: colors.onSurface,
    todayTextColor: colors.primary,
    selectedDayBackgroundColor: colors.primary,
    selectedDayTextColor: colors.onPrimary,
    monthTextColor: colors.onSurface,
    arrowColor: colors.primary,
    textDisabledColor: colors.outlineVariant,
  }}
  markedDates={{
    '2026-04-15': { marked: true, dotColor: colors.primary },
    '2026-04-20': { selected: true, selectedColor: colors.primary },
  }}
  onDayPress={(day) => handleDateSelect(day.dateString)}
/>
```
Use for: habit trackers (dot marking), mood logs (multi-dot), date pickers, history views. Format dates as 'YYYY-MM-DD' strings.

### Progress Ring (react-native-svg — pre-installed)
```tsx
import Svg, { Circle } from 'react-native-svg';

interface ProgressRingProps {
  progress: number; // 0-1
  size: number;
  strokeWidth: number;
  color: string;
}

function ProgressRing({ progress, size, strokeWidth, color }: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={radius}
        stroke={color} strokeOpacity={0.2} strokeWidth={strokeWidth} fill="none" />
      <Circle cx={size / 2} cy={size / 2} r={radius}
        stroke={color} strokeWidth={strokeWidth} fill="none"
        strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
        strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`} />
    </Svg>
  );
}
```
Use for: timers (pomodoro), goals (daily progress), stats (completion percentage).

### Typography
```tsx
<Text variant="displayMedium">Big number</Text>     // 45px — hero metrics
<Text variant="headlineMedium">Screen title</Text>   // 28px — page headers
<Text variant="titleMedium">Card title</Text>         // 16px — list item titles
<Text variant="bodyLarge">Body text</Text>             // 16px — descriptions
<Text variant="bodyMedium">Secondary text</Text>       // 14px — metadata
<Text variant="labelMedium">Caption</Text>             // 12px — labels, timestamps
```

---

## RUNTIME PITFALLS (compiles but crashes or looks broken)

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| SafeAreaView from `react-native` | Deprecated warning, layout broken | Import from `react-native-safe-area-context` |
| Missing `flexDirection: 'row'` on rows | Items stack vertically instead of horizontally | Always set `flexDirection: 'row'` for horizontal layout |
| Missing `flex: 1` on container | Content invisible (zero height) | Add `flex: 1` to Views that should fill space |
| FlatList inside ScrollView | Warning, nested scroll broken | Remove ScrollView, let FlatList handle scrolling |
| `\n` in Text strings | Renders literal "\n" text | Use separate `<Text>` elements |
| Zustand selector returns new array | Infinite re-renders | Select raw data, derive with `useMemo` |
| `onPress={() => {}}` | Button does nothing, no error | Wire to real store action or navigation |
| DOMParser / document / window | White screen crash | Use `fast-xml-parser` for XML, avoid browser APIs |
| `crypto.randomUUID()` | Crash in Hermes | Use `Date.now().toString(36) + Math.random().toString(36).slice(2)` |

---

## RULES

- Zustand selectors: select raw data only, NEVER call methods returning new arrays. Derive with useMemo.
- Zustand object/array selectors: use `useShallow` to prevent re-renders: `useStore(useShallow((s) => ({ a: s.a, b: s.b })))`.
- Components max 250 lines. If larger — split into sub-components.
- If Paper has the component — use it. Don't reinvent with raw View/Pressable.
- After implementation, run: npx tsc --noEmit — fix ALL errors before finishing.
