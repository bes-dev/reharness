import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";

export const PACKAGES = [
  "expo-router", "expo-font", "expo-splash-screen", "expo-image",
  "@react-native-async-storage/async-storage", "react-native-safe-area-context",
  "react-native-gesture-handler", "react-native-reanimated", "react-native-screens",
  "expo-status-bar", "expo-linking", "expo-constants", "react-native-paper", "zustand",
  "babel-preset-expo",
  "react-native-gifted-charts", "react-native-svg", "expo-linear-gradient",
  "react-native-calendars",
];

// Scaffold uses a neutral dark base. UI agent overrides with PRD visual style.
const THEME = { base: "MD3DarkTheme", bg: "#121212", surface: "#1E1E1E" };

// Non-blocking shell exec
function runShell(cmd: string, cwd: string, timeout = 180000): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const timer = setTimeout(() => { proc.kill(); rej(new Error(`Timeout: ${cmd.slice(0, 60)}`)); }, timeout);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`Exit ${code}: ${stderr.slice(-300)}`));
    });
    proc.on("error", (err) => { clearTimeout(timer); rej(err); });
  });
}

export async function scaffold(root: string, slug: string, name: string): Promise<string[]> {
  const appDir = resolve(root, "apps", slug);
  const t = THEME;
  const log: string[] = [];

  mkdirSync(resolve(root, "apps"), { recursive: true });

  // Step 1: create-expo-app (only if no package.json)
  if (!existsSync(resolve(appDir, "package.json"))) {
    const tmpDir = resolve(root, `_tmp_init_${slug}`);
    try { execSync(`rm -rf "${tmpDir}"`, { encoding: "utf-8" }); } catch {}

    await runShell(
      `npx create-expo-app@latest "${tmpDir}" --template blank-typescript`,
      root, 120000
    );
    log.push("✓ create-expo-app");

    if (!existsSync(appDir)) {
      execSync(`mv "${tmpDir}" "${appDir}"`, { encoding: "utf-8" });
    } else {
      execSync(`rsync -a --ignore-existing "${tmpDir}/" "${appDir}/"`, { encoding: "utf-8" });
      execSync(`rm -rf "${tmpDir}"`, { encoding: "utf-8" });
    }
  } else {
    log.push("✓ project exists");
  }

  // Step 2: Cleanup template files
  for (const f of ["App.tsx", "app.json"]) {
    const p = resolve(appDir, f);
    if (existsSync(p)) try { require("fs").unlinkSync(p); } catch {}
  }

  // Step 3: Configure project (sync — instant, no blocking)
  const pkg = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf-8"));
  pkg.name = slug;
  pkg.main = "expo-router/entry";
  writeFileSync(resolve(appDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  writeFileSync(resolve(appDir, "index.ts"), 'import "expo-router/entry";\n');

  writeFileSync(resolve(appDir, "babel.config.js"),
`module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
};
`);

  writeFileSync(resolve(appDir, "tsconfig.json"), JSON.stringify({
    extends: "expo/tsconfig.base",
    compilerOptions: { strict: true, baseUrl: ".", paths: { "@/*": ["src/*"] } },
    include: ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"],
  }, null, 2) + "\n");

  writeFileSync(resolve(appDir, "app.config.js"),
`export default {
  name: "${name}",
  slug: "${slug}",
  version: "1.0.0",
  orientation: "portrait",
  scheme: "${slug}",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  splash: { backgroundColor: "${t.bg}" },
  ios: { supportsTablet: true, bundleIdentifier: "com.app.${slug.replace(/-/g, "")}" },
  android: { adaptiveIcon: { backgroundColor: "${t.bg}" }, package: "com.app.${slug.replace(/-/g, "")}" },
  plugins: ["expo-router"],
};
`);

  // Step 4: Install packages (async — non-blocking)
  try {
    await runShell(`npx expo install ${PACKAGES.join(" ")}`, appDir, 180000);
  } catch {
    const pkg2 = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf-8"));
    const installed = PACKAGES.filter(p => pkg2.dependencies?.[p] || pkg2.devDependencies?.[p]);
    if (installed.length < PACKAGES.length * 0.8) {
      throw new Error(`Only ${installed.length}/${PACKAGES.length} packages installed`);
    }
  }
  log.push(`✓ ${PACKAGES.length} packages`);

  // Step 5: Directories + layout
  for (const dir of ["src/types", "src/stores", "src/services", "src/components", "app", "assets"]) {
    mkdirSync(resolve(appDir, dir), { recursive: true });
  }

  // Error Boundary
  const ebPath = resolve(appDir, "src/components/ErrorBoundary.tsx");
  if (!existsSync(ebPath)) {
    writeFileSync(ebPath,
`import React, { Component, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, Button, useTheme } from 'react-native-paper';

interface Props { children: ReactNode }
interface State { hasError: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(): State { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text variant="headlineSmall">Something went wrong</Text>
          <Button mode="contained" onPress={() => this.setState({ hasError: false })}>Try Again</Button>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 16 },
});
`);
  }

  // Root layout with ErrorBoundary
  const layoutPath = resolve(appDir, "app/_layout.tsx");
  if (!existsSync(layoutPath)) {
    writeFileSync(layoutPath,
`import { PaperProvider, ${t.base} } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const theme = {
  ...${t.base},
  colors: { ...${t.base}.colors, background: '${t.bg}', surface: '${t.surface}' },
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <SafeAreaProvider>
        <PaperProvider theme={theme}>
          <ErrorBoundary>
            <Stack screenOptions={{ headerShown: false }} />
          </ErrorBoundary>
        </PaperProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
`);
  }
  log.push("✓ layout + theme stub");

  return log;
}
