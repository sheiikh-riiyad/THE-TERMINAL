import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, onValue, ref } from 'firebase/database';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const STORAGE_KEY = 'the-terminal-live-weight-pairing';
const PAIRING_SCHEME = 'the-terminal://live-weight';
const STALE_AFTER_MS = 8000;
const TERMINAL_STATUS_STALE_AFTER_MS = 45000;

function decodeQueryValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, ' '));
  } catch (_error) {
    return '';
  }
}

function parseQuery(queryString) {
  return String(queryString || '')
    .split('&')
    .filter(Boolean)
    .reduce((params, part) => {
      const splitAt = part.indexOf('=');
      const rawKey = splitAt >= 0 ? part.slice(0, splitAt) : part;
      const rawValue = splitAt >= 0 ? part.slice(splitAt + 1) : '';
      params[decodeQueryValue(rawKey)] = decodeQueryValue(rawValue);
      return params;
    }, {});
}

function normalizeDatabaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/g, '')
    .replace(/\.json$/i, '')
    .replace(/\/+/g, '/');
}

function parsePairingText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    throw new Error('Pairing data is empty.');
  }

  let params;
  if (rawText.startsWith('{')) {
    params = JSON.parse(rawText);
  } else {
    const queryStart = rawText.indexOf('?');
    const base = queryStart >= 0 ? rawText.slice(0, queryStart).toLowerCase() : rawText.toLowerCase();
    if (base !== PAIRING_SCHEME) {
      throw new Error('This QR code is not a The Terminal pairing code.');
    }
    params = parseQuery(rawText.slice(queryStart + 1));
  }

  const databaseURL = normalizeDatabaseUrl(params.databaseURL);
  const path = normalizePath(params.path);
  const fallbackStatusPath = path.replace(/\/latest$/i, '/status');
  const statusPath = normalizePath(params.statusPath || fallbackStatusPath);
  const terminalStaleAfterMs = Number(params.terminalStaleAfterMs);
  const productCode = String(params.productCode || path.split('/')[1] || '').trim();

  if (!/^https:\/\/.+\.(firebasedatabase\.app|firebaseio\.com)$/i.test(databaseURL)) {
    throw new Error('Firebase database URL is missing or invalid.');
  }
  if (!/^scales\/[^/]+\/latest$/i.test(path)) {
    throw new Error('Live weight path is missing or invalid.');
  }
  if (!/^scales\/[^/]+\/status$/i.test(statusPath)) {
    throw new Error('Terminal status path is missing or invalid.');
  }
  if (!productCode) {
    throw new Error('Product code is missing.');
  }

  return {
    databaseURL,
    path,
    statusPath,
    terminalStaleAfterMs: Number.isFinite(terminalStaleAfterMs)
      ? terminalStaleAfterMs
      : TERMINAL_STATUS_STALE_AFTER_MS,
    productCode,
    pairedAt: new Date().toISOString()
  };
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getFirebaseApp(databaseURL) {
  const appName = `terminal-live-${hashString(databaseURL)}`;
  const existingApp = getApps().find((app) => app.name === appName);
  if (existingApp) return existingApp;
  return initializeApp({ databaseURL }, appName);
}

function normalizeLiveValue(value) {
  if (value == null) return null;

  if (typeof value === 'number') {
    return {
      weight: value,
      unit: 'kg',
      decimalPlaces: 2,
      updatedAt: null,
      updatedAtMs: null,
      raw: value
    };
  }

  const numericWeight = Number(value.weight);
  const decimalPlaces = Number.isInteger(value.decimalPlaces)
    ? Math.min(Math.max(value.decimalPlaces, 0), 4)
    : 2;

  return {
    weight: Number.isFinite(numericWeight) ? numericWeight : null,
    unit: value.unit || 'kg',
    decimalPlaces,
    updatedAt: value.updatedAt || null,
    updatedAtMs: Number.isFinite(Number(value.updatedAtMs)) ? Number(value.updatedAtMs) : null,
    user: value.user || null,
    productCode: value.productCode || null,
    raw: value
  };
}

function normalizeTerminalStatus(value) {
  if (!value || typeof value !== 'object') return null;

  const updatedAtMs = Number(value.updatedAtMs);
  const staleAfterMs = Number(value.staleAfterMs);
  return {
    state: value.state || (value.online ? 'online' : 'offline'),
    online: Boolean(value.online),
    updatedAt: value.updatedAt || null,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : null,
    appVersion: value.appVersion || null,
    hostname: value.hostname || null,
    user: value.user || null,
    raw: value
  };
}

function formatWeight(liveValue) {
  if (!liveValue || liveValue.weight == null) return '--';
  return liveValue.weight.toFixed(liveValue.decimalPlaces);
}

function formatTimestamp(liveValue) {
  const timestamp = liveValue?.updatedAtMs || (liveValue?.updatedAt ? Date.parse(liveValue.updatedAt) : null);
  if (!timestamp || Number.isNaN(timestamp)) return 'Not received';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getHostName(databaseURL) {
  return normalizeDatabaseUrl(databaseURL).replace(/^https:\/\//i, '');
}

function formatTerminalStatusTime(terminalStatus) {
  const timestamp = terminalStatus?.updatedAtMs ||
    (terminalStatus?.updatedAt ? Date.parse(terminalStatus.updatedAt) : null);
  if (!timestamp || Number.isNaN(timestamp)) return 'No heartbeat received';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [pairing, setPairing] = useState(null);
  const [isLoadingPairing, setIsLoadingPairing] = useState(true);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [manualText, setManualText] = useState('');
  const [liveValue, setLiveValue] = useState(null);
  const [terminalStatus, setTerminalStatus] = useState(null);
  const [firebaseConnected, setFirebaseConnected] = useState(null);
  const [listenerError, setListenerError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let mounted = true;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((storedPairing) => {
        if (!mounted || !storedPairing) return;
        setPairing(JSON.parse(storedPairing));
      })
      .catch(() => {
        if (mounted) {
          AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
        }
      })
      .finally(() => {
        if (mounted) setIsLoadingPairing(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const connectFromText = useCallback(async (value) => {
    try {
      const nextPairing = parsePairingText(value);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextPairing));
      setPairing(nextPairing);
      setManualText('');
      setScannerOpen(false);
      setScanLocked(false);
      Keyboard.dismiss();
      return true;
    } catch (error) {
      setScanLocked(false);
      Alert.alert('Pairing failed', error?.message || 'Invalid pairing data.');
      return false;
    }
  }, []);

  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => {
        if (url && String(url).toLowerCase().startsWith(PAIRING_SCHEME)) {
          connectFromText(url);
        }
      })
      .catch(() => {});

    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (url && String(url).toLowerCase().startsWith(PAIRING_SCHEME)) {
        connectFromText(url);
      }
    });

    return () => subscription.remove();
  }, [connectFromText]);

  useEffect(() => {
    if (!pairing) {
      setLiveValue(null);
      setTerminalStatus(null);
      setFirebaseConnected(null);
      setListenerError('');
      return undefined;
    }

    let mounted = true;
    setLiveValue(null);
    setTerminalStatus(null);
    setFirebaseConnected(null);
    setListenerError('');

    try {
      const app = getFirebaseApp(pairing.databaseURL);
      const database = getDatabase(app, pairing.databaseURL);
      const liveRef = ref(database, pairing.path);
      const statusRef = ref(database, pairing.statusPath);
      const connectedRef = ref(database, '.info/connected');

      const unsubscribeLive = onValue(
        liveRef,
        (snapshot) => {
          if (!mounted) return;
          setListenerError('');
          setLiveValue(normalizeLiveValue(snapshot.val()));
        },
        (error) => {
          if (!mounted) return;
          setListenerError(error?.message || 'Failed to read live weight.');
        }
      );

      const unsubscribeConnection = onValue(connectedRef, (snapshot) => {
        if (mounted) setFirebaseConnected(Boolean(snapshot.val()));
      });

      const unsubscribeStatus = onValue(
        statusRef,
        (snapshot) => {
          if (!mounted) return;
          setTerminalStatus(normalizeTerminalStatus(snapshot.val()));
        },
        (error) => {
          if (!mounted) return;
          setListenerError(error?.message || 'Failed to read terminal status.');
        }
      );

      return () => {
        mounted = false;
        unsubscribeLive();
        unsubscribeStatus();
        unsubscribeConnection();
      };
    } catch (error) {
      setListenerError(error?.message || 'Failed to start Firebase listener.');
      return undefined;
    }
  }, [pairing]);

  const liveAgeMs = useMemo(() => {
    const timestamp = liveValue?.updatedAtMs || (liveValue?.updatedAt ? Date.parse(liveValue.updatedAt) : null);
    if (!timestamp || Number.isNaN(timestamp)) return null;
    return Math.max(0, now - timestamp);
  }, [liveValue, now]);

  const terminalAgeMs = useMemo(() => {
    const timestamp = terminalStatus?.updatedAtMs ||
      (terminalStatus?.updatedAt ? Date.parse(terminalStatus.updatedAt) : null);
    if (!timestamp || Number.isNaN(timestamp)) return null;
    return Math.max(0, now - timestamp);
  }, [terminalStatus, now]);

  const terminalStatusView = useMemo(() => {
    if (!pairing) return { label: 'Not paired', detail: 'Pair a terminal first', tone: 'neutral' };
    if (firebaseConnected === false) {
      return { label: 'Offline', detail: 'Mobile is disconnected from Firebase', tone: 'warning' };
    }
    if (!terminalStatus) {
      return { label: 'Waiting', detail: 'Waiting for terminal heartbeat', tone: 'neutral' };
    }

    const staleAfterMs = terminalStatus.staleAfterMs ||
      pairing.terminalStaleAfterMs ||
      TERMINAL_STATUS_STALE_AFTER_MS;
    if (terminalStatus.online && terminalAgeMs != null && terminalAgeMs <= staleAfterMs) {
      return {
        label: 'Online',
        detail: `Heartbeat ${formatTerminalStatusTime(terminalStatus)}`,
        tone: 'success'
      };
    }

    return {
      label: 'Offline',
      detail: terminalStatus.online
        ? `Heartbeat stale since ${formatTerminalStatusTime(terminalStatus)}`
        : `Last seen ${formatTerminalStatusTime(terminalStatus)}`,
      tone: 'warning'
    };
  }, [firebaseConnected, pairing, terminalAgeMs, terminalStatus]);

  const status = useMemo(() => {
    if (listenerError) return { label: 'Error', tone: 'error' };
    if (!pairing) return { label: 'Not paired', tone: 'neutral' };
    if (firebaseConnected === false) return { label: 'Offline', tone: 'warning' };
    if (terminalStatusView.label === 'Offline') return { label: 'Offline', tone: 'warning' };
    if (terminalStatusView.label === 'Online') return { label: 'Online', tone: 'success' };
    if (!liveValue) return { label: 'Waiting', tone: 'neutral' };
    if (liveAgeMs != null && liveAgeMs > STALE_AFTER_MS) return { label: 'Stale', tone: 'warning' };
    return { label: 'Live', tone: 'success' };
  }, [firebaseConnected, listenerError, liveAgeMs, liveValue, pairing, terminalStatusView]);

  async function openScanner() {
    if (!permission?.granted) {
      const nextPermission = await requestPermission();
      if (!nextPermission?.granted) {
        Alert.alert('Camera permission needed', 'Allow camera access to scan the pairing QR code.');
        return;
      }
    }
    setScanLocked(false);
    setScannerOpen(true);
  }

  function handleBarcodeScanned(result) {
    if (scanLocked) return;
    setScanLocked(true);
    connectFromText(result?.data);
  }

  async function disconnectTerminal() {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setPairing(null);
    setLiveValue(null);
    setTerminalStatus(null);
    setFirebaseConnected(null);
    setListenerError('');
  }

  if (isLoadingPairing) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <View style={styles.centered}>
          <ActivityIndicator color="#246b61" size="large" />
          <Text style={styles.loadingText}>Loading pairing</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (scannerOpen) {
    return (
      <SafeAreaView style={styles.scannerSafe}>
        <StatusBar style="light" />
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanLocked ? undefined : handleBarcodeScanned}
        />
        <View style={styles.scannerTopBar}>
          <Text style={styles.scannerTitle}>Scan Pairing QR</Text>
          <Pressable style={styles.scannerCloseButton} onPress={() => setScannerOpen(false)}>
            <Text style={styles.scannerCloseText}>Close</Text>
          </Pressable>
        </View>
        <View style={styles.scanFrame} pointerEvents="none" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View>
            <Text style={styles.appName}>The Terminal Live</Text>
            <Text style={styles.appSubTitle}>Mobile weight monitor</Text>
          </View>
          <View style={[styles.statusBadge, styles[`status_${status.tone}`]]}>
            <Text style={[styles.statusText, styles[`statusText_${status.tone}`]]}>{status.label}</Text>
          </View>
        </View>

        {pairing ? (
          <>
            <View style={styles.weightBand}>
              <Text style={styles.weightLabel}>Current Weight</Text>
              <View style={styles.weightRow}>
                <Text adjustsFontSizeToFit numberOfLines={1} style={styles.weightValue}>
                  {formatWeight(liveValue)}
                </Text>
                <Text style={styles.weightUnit}>{liveValue?.unit || 'kg'}</Text>
              </View>
              <Text style={styles.weightTime}>Updated {formatTimestamp(liveValue)}</Text>
            </View>

            {listenerError ? <Text style={styles.errorText}>{listenerError}</Text> : null}

            <View style={styles.detailsGrid}>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Terminal Status</Text>
                <Text style={[styles.detailValue, styles[`detailValue_${terminalStatusView.tone}`]]}>
                  {terminalStatusView.label}
                </Text>
                <Text style={styles.detailHint}>{terminalStatusView.detail}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Product Code</Text>
                <Text selectable style={styles.detailValue}>{pairing.productCode}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Firebase</Text>
                <Text selectable numberOfLines={2} style={styles.detailValue}>
                  {getHostName(pairing.databaseURL)}
                </Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Live Path</Text>
                <Text selectable numberOfLines={2} style={styles.detailValue}>{pairing.path}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Status Path</Text>
                <Text selectable numberOfLines={2} style={styles.detailValue}>{pairing.statusPath}</Text>
              </View>
              <View style={styles.detailItem}>
                <Text style={styles.detailLabel}>Operator</Text>
                <Text style={styles.detailValue}>
                  {terminalStatus?.user?.username || liveValue?.user?.username || 'Not available'}
                </Text>
              </View>
            </View>

            <View style={styles.actions}>
              <Pressable style={styles.secondaryButton} onPress={openScanner}>
                <Text style={styles.secondaryButtonText}>Rescan</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={disconnectTerminal}>
                <Text style={styles.dangerButtonText}>Disconnect</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={styles.pairingPanel}>
              <Text style={styles.panelTitle}>Pair Terminal</Text>
              <Text style={styles.panelText}>Connect this phone with the QR code shown on the desktop login screen.</Text>
              <Pressable style={styles.primaryButton} onPress={openScanner}>
                <Text style={styles.primaryButtonText}>Scan QR Code</Text>
              </Pressable>
            </View>

            <View style={styles.manualPanel}>
              <Text style={styles.panelTitle}>Paste Pairing Data</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                numberOfLines={4}
                onChangeText={setManualText}
                placeholder="the-terminal://live-weight?..."
                placeholderTextColor="#7b8791"
                style={styles.input}
                value={manualText}
              />
              <Pressable
                disabled={!manualText.trim()}
                onPress={() => connectFromText(manualText)}
                style={[styles.secondaryButton, !manualText.trim() && styles.disabledButton]}
              >
                <Text style={[styles.secondaryButtonText, !manualText.trim() && styles.disabledButtonText]}>
                  Connect
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f4f7f6'
  },
  scannerSafe: {
    flex: 1,
    backgroundColor: '#07130f'
  },
  content: {
    flexGrow: 1,
    padding: 20,
    gap: 18
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12
  },
  loadingText: {
    color: '#31443f',
    fontSize: 15,
    fontWeight: '600'
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
    paddingTop: 8
  },
  appName: {
    color: '#172521',
    fontSize: 28,
    fontWeight: '800'
  },
  appSubTitle: {
    color: '#5b6965',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4
  },
  statusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    minWidth: 82,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  statusText: {
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    textTransform: 'uppercase'
  },
  status_success: {
    backgroundColor: '#e5f6ef',
    borderColor: '#97d6bd'
  },
  status_warning: {
    backgroundColor: '#fff2d8',
    borderColor: '#e7b75b'
  },
  status_error: {
    backgroundColor: '#fde8e8',
    borderColor: '#ef9a9a'
  },
  status_neutral: {
    backgroundColor: '#e9eef2',
    borderColor: '#c9d4dc'
  },
  statusText_success: {
    color: '#176146'
  },
  statusText_warning: {
    color: '#87530d'
  },
  statusText_error: {
    color: '#9b1c1c'
  },
  statusText_neutral: {
    color: '#40515a'
  },
  weightBand: {
    backgroundColor: '#132823',
    borderRadius: 8,
    overflow: 'hidden',
    padding: 22
  },
  weightLabel: {
    color: '#a9c1bb',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  weightRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 10,
    marginTop: 12
  },
  weightValue: {
    color: '#ffffff',
    flexShrink: 1,
    fontSize: 70,
    fontWeight: '900',
    lineHeight: 78
  },
  weightUnit: {
    color: '#7dd3ae',
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 46
  },
  weightTime: {
    color: '#b9c8c4',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 10
  },
  errorText: {
    backgroundColor: '#fff5f5',
    borderColor: '#f3b8b8',
    borderRadius: 8,
    borderWidth: 1,
    color: '#912323',
    fontSize: 14,
    fontWeight: '700',
    padding: 12
  },
  detailsGrid: {
    gap: 12
  },
  detailItem: {
    backgroundColor: '#ffffff',
    borderColor: '#d9e2df',
    borderRadius: 8,
    borderWidth: 1,
    padding: 14
  },
  detailLabel: {
    color: '#63736e',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase'
  },
  detailValue: {
    color: '#182722',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 7
  },
  detailValue_success: {
    color: '#176146'
  },
  detailValue_warning: {
    color: '#87530d'
  },
  detailValue_error: {
    color: '#9b1c1c'
  },
  detailValue_neutral: {
    color: '#40515a'
  },
  detailHint: {
    color: '#63736e',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    marginTop: 4
  },
  actions: {
    flexDirection: 'row',
    gap: 12
  },
  pairingPanel: {
    backgroundColor: '#ffffff',
    borderColor: '#d9e2df',
    borderRadius: 8,
    borderWidth: 1,
    padding: 18
  },
  manualPanel: {
    backgroundColor: '#ffffff',
    borderColor: '#d9e2df',
    borderRadius: 8,
    borderWidth: 1,
    padding: 18
  },
  panelTitle: {
    color: '#172521',
    fontSize: 19,
    fontWeight: '800'
  },
  panelText: {
    color: '#5b6965',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 21,
    marginTop: 7
  },
  input: {
    backgroundColor: '#f7faf9',
    borderColor: '#cbd8d4',
    borderRadius: 8,
    borderWidth: 1,
    color: '#172521',
    fontSize: 14,
    minHeight: 112,
    marginTop: 14,
    padding: 12,
    textAlignVertical: 'top'
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#246b61',
    borderRadius: 8,
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 48,
    paddingHorizontal: 18
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900'
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#eef6f3',
    borderColor: '#9fc9bc',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 46,
    paddingHorizontal: 16
  },
  secondaryButtonText: {
    color: '#1f6254',
    fontSize: 15,
    fontWeight: '900'
  },
  dangerButton: {
    alignItems: 'center',
    backgroundColor: '#fff1f1',
    borderColor: '#e2a7a7',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 46,
    paddingHorizontal: 16
  },
  dangerButtonText: {
    color: '#9b2424',
    fontSize: 15,
    fontWeight: '900'
  },
  disabledButton: {
    backgroundColor: '#edf1ef',
    borderColor: '#d1dcda'
  },
  disabledButtonText: {
    color: '#8b9693'
  },
  camera: {
    flex: 1
  },
  scannerTopBar: {
    alignItems: 'center',
    backgroundColor: 'rgba(7, 19, 15, 0.86)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 18,
    paddingVertical: 14,
    position: 'absolute',
    right: 0,
    top: 0
  },
  scannerTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '900'
  },
  scannerCloseButton: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  scannerCloseText: {
    color: '#172521',
    fontSize: 14,
    fontWeight: '900'
  },
  scanFrame: {
    alignSelf: 'center',
    borderColor: '#7dd3ae',
    borderRadius: 8,
    borderWidth: 3,
    height: 250,
    position: 'absolute',
    top: '32%',
    width: 250
  }
});
