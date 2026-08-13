import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Platform, Pressable, RefreshControl, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEVICE_TOKEN_KEY, SPACE_ID_KEY, supabase } from './src/supabase';

type Item = { id: string; type: 'file' | 'text'; title: string; text_content: string | null; original_filename: string | null; mime_type: string | null; file_size: number | null; created_at: string };
type PairResult = { transferSpaceId: string; deviceAccessToken: string };

const formatBytes = (value: number | null) => !value ? '' : value > 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
const fileName = (value: string) => value.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-120) || 'quickdrop-file';

export default function App() {
  const [ready, setReady] = useState(false);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [items, setItems] = useState<Item[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [activeText, setActiveText] = useState<Item | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const invoke = useCallback(async <T,>(name: string, body: Record<string, unknown>, token = deviceToken): Promise<T> => {
    const { data, error } = await supabase().functions.invoke(name, { body, headers: token ? { 'x-device-access-token': token } : undefined });
    if (error) {
      const response = (error as { context?: Response }).context;
      if (response instanceof Response) { const payload = await response.json() as { error?: { code?: string; message?: string } }; throw new Error(payload.error?.code ?? payload.error?.message ?? 'REQUEST_FAILED'); }
      throw error;
    }
    if ((data as { error?: { code?: string } })?.error) throw new Error((data as { error: { code: string } }).error.code);
    return data as T;
  }, [deviceToken]);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    setRefreshing(true);
    try {
      const { data, error } = await supabase().from('transfer_items').select('id,type,title,text_content,original_filename,mime_type,file_size,created_at').eq('transfer_space_id', spaceId).order('created_at', { ascending: false });
      if (error) throw error; setItems((data ?? []) as Item[]);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : '读取传输列表失败。'); }
    finally { setRefreshing(false); }
  }, [spaceId]);

  useEffect(() => {
    async function bootstrap() {
      try {
        const client = supabase(); const { data } = await client.auth.getSession();
        if (!data.session) { const { error } = await client.auth.signInAnonymously(); if (error) throw error; }
        const [storedSpace, storedToken] = await Promise.all([SecureStore.getItemAsync(SPACE_ID_KEY), SecureStore.getItemAsync(DEVICE_TOKEN_KEY)]);
        if (storedSpace && storedToken) { setSpaceId(storedSpace); setDeviceToken(storedToken); }
      } catch (caught) { setMessage(caught instanceof Error ? caught.message : '无法建立匿名会话。'); }
      finally { setReady(true); }
    }
    void bootstrap();
  }, []);

  useEffect(() => { if (spaceId) void refresh(); }, [refresh, spaceId]);
  useEffect(() => {
    if (!spaceId) return;
    const channel = supabase().channel(`quickdrop-mobile-${spaceId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'transfer_items', filter: `transfer_space_id=eq.${spaceId}` }, () => void refresh()).subscribe();
    return () => { void supabase().removeChannel(channel); };
  }, [refresh, spaceId]);

  const explainPairingError = (reason: string) => ({ PAIRING_INVALID: '验证码无效。', PAIRING_EXPIRED: '验证码已过期，请让网页重新生成。', PAIRING_USED: '验证码已使用，请让网页重新生成。', PAIRING_LOCKED: '该验证码尝试次数过多，已锁定。', RATE_LIMITED: '尝试次数过多，请 15 分钟后再试。', DEVICE_LIMIT: '该电脑已连接 3 台手机。' }[reason] ?? '配对失败，请检查网络和验证码。');
  const pair = async (payload: { code?: string; pairingToken?: string }) => {
    setPairing(true); setMessage('正在安全配对…');
    try {
      const result = await invoke<PairResult>('pair-device', { ...payload, deviceName: `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} 手机`, deviceType: Platform.OS === 'ios' ? 'ios' : 'android' }, null);
      await Promise.all([SecureStore.setItemAsync(DEVICE_TOKEN_KEY, result.deviceAccessToken), SecureStore.setItemAsync(SPACE_ID_KEY, result.transferSpaceId)]);
      setDeviceToken(result.deviceAccessToken); setSpaceId(result.transferSpaceId); setCode(''); setScanning(false); setMessage('配对成功。');
    } catch (caught) { setMessage(explainPairingError(caught instanceof Error ? caught.message : '')); }
    finally { setPairing(false); }
  };
  const startScanner = async () => { if (!cameraPermission?.granted) { const result = await requestCameraPermission(); if (!result.granted) { setMessage('需要相机权限才能扫描二维码。'); return; } } setScanning(true); };
  const onScan = ({ data }: { data: string }) => {
    if (!scanning) return;
    try { const value = JSON.parse(data) as { pairingToken?: string }; if (!value.pairingToken) throw new Error(); setScanning(false); void pair({ pairingToken: value.pairingToken }); }
    catch { setMessage('这不是 QuickDrop 配对二维码。'); }
  };

  const getUrl = async (item: Item) => invoke<{ url: string }>('get-download-url', { transferSpaceId: spaceId, transferItemId: item.id });
  const openFile = async (item: Item) => {
    try {
      const { url } = await getUrl(item);
      if (item.mime_type?.startsWith('image/')) { setPreviewUrl(url); return; }
      if (item.mime_type === 'application/pdf') { await Linking.openURL(url); return; }
      const target = `${FileSystem.cacheDirectory}${fileName(item.original_filename ?? item.title)}`;
      const result = await FileSystem.downloadAsync(url, target);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(result.uri); else await Linking.openURL(url);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : '无法下载文件。'); }
  };
  const copyText = async (text: string | null) => { await Clipboard.setStringAsync(text ?? ''); setMessage('文字已复制到剪贴板。'); };
  const shareFile = async (item: Item) => {
    try {
      const data = await invoke<{ shareUrl: string; expiresAt: string }>('create-file-share-link', { transferSpaceId: spaceId, transferItemId: item.id });
      await Share.share({ message: `QuickDrop 文件：${item.title}\n${data.shareUrl}`, url: data.shareUrl, title: item.title });
      setMessage(`分享链接已生成，将在 ${new Date(data.expiresAt).toLocaleTimeString()} 失效。`);
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : '无法创建分享链接。'); }
  };
  const fromClipboard = async () => { const text = await Clipboard.getStringAsync(); if (!text.trim()) { setMessage('剪贴板中没有文字。'); return; } try { await invoke('create-text-item', { transferSpaceId: spaceId, text }); setMessage('剪贴板文字已同步。'); } catch { setMessage('同步剪贴板文字失败。'); } };
  const chooseFiles = async () => {
    if (!spaceId) return; setUploading(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: false });
      if (picked.canceled) return;
      for (const asset of picked.assets) {
        const size = asset.size ?? 0; const mimeType = asset.mimeType ?? 'application/octet-stream';
        const ticket = await invoke<{ storagePath: string; signedUrl: string; filename: string }>('create-upload-url', { transferSpaceId: spaceId, filename: asset.name, mimeType, size });
        const blob = await (await fetch(asset.uri)).blob();
        const response = await fetch(ticket.signedUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
        if (!response.ok) throw new Error('文件上传失败。');
        await invoke('complete-upload', { transferSpaceId: spaceId, storagePath: ticket.storagePath, filename: ticket.filename, mimeType, size });
      }
      setMessage('文件已同步。');
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : '选择文件失败。'); }
    finally { setUploading(false); }
  };
  const deleteItem = (item: Item) => Alert.alert('删除传输项', '确定删除此内容吗？', [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void invoke('delete-transfer-item', { transferSpaceId: spaceId, transferItemId: item.id }).then(refresh).catch(() => setMessage('删除失败。')) }]);
  const disconnect = () => Alert.alert('断开此电脑', '将删除本机设备凭证，之后需使用新验证码重新配对。', [{ text: '取消', style: 'cancel' }, { text: '断开', style: 'destructive', onPress: () => void Promise.all([SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY), SecureStore.deleteItemAsync(SPACE_ID_KEY)]).then(() => { setSpaceId(null); setDeviceToken(null); setItems([]); setMessage('已断开。'); }) }]);
  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query ? items.filter((item) => `${item.title}\n${item.text_content ?? ''}`.toLocaleLowerCase().includes(query)) : items;
  }, [items, searchQuery]);

  if (!ready) return <SafeAreaView style={styles.center}><ActivityIndicator /><Text style={styles.muted}>正在建立匿名会话…</Text></SafeAreaView>;
  if (!spaceId || !deviceToken) return <SafeAreaView style={styles.screen}><StatusBar style="light" /><View style={styles.header}><Text style={styles.eyebrow}>无需账号 · 临时传输</Text><Text style={styles.title}>连接电脑</Text><Text style={styles.muted}>输入网页上的 4 位验证码，或扫描网页二维码。</Text></View>{message ? <Text style={styles.notice}>{message}</Text> : null}{scanning ? <View style={styles.cameraWrap}><CameraView style={styles.camera} facing="back" onBarcodeScanned={onScan} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} /><Pressable style={styles.secondaryButton} onPress={() => setScanning(false)}><Text style={styles.secondaryText}>取消扫描</Text></Pressable></View> : <View style={styles.card}><TextInput value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" placeholder="4 位验证码" placeholderTextColor="#7e91a8" style={styles.codeInput} maxLength={4} /><Pressable style={styles.primaryButton} disabled={code.length !== 4 || pairing} onPress={() => void pair({ code })}><Text style={styles.primaryText}>{pairing ? '配对中…' : '连接电脑'}</Text></Pressable><Pressable style={styles.secondaryButton} onPress={() => void startScanner()}><Text style={styles.secondaryText}>扫描网页二维码</Text></Pressable></View>}</SafeAreaView>;

  return <SafeAreaView style={styles.screen}>
    <StatusBar style="light" />
    <View style={styles.topRow}><View><Text style={styles.eyebrow}>已安全连接</Text><Text style={styles.title}>传输列表</Text></View><Pressable onPress={disconnect}><Text style={styles.dangerText}>断开电脑</Text></Pressable></View>
    {message ? <Text style={styles.notice}>{message}</Text> : null}
    <View style={styles.actions}><Pressable style={styles.primaryButton} onPress={() => void chooseFiles()} disabled={uploading}><Text style={styles.primaryText}>{uploading ? '上传中…' : '上传文件'}</Text></Pressable><Pressable style={styles.secondaryButton} onPress={() => void fromClipboard()}><Text style={styles.secondaryText}>从剪贴板导入文字</Text></Pressable></View>
    <TextInput value={searchQuery} onChangeText={setSearchQuery} placeholder="搜索文件或文字" placeholderTextColor="#7e91a8" style={styles.searchInput} />
    <FlatList data={visibleItems} keyExtractor={(item) => item.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor="#55e0b0" />} contentContainerStyle={styles.list} ListEmptyComponent={<Text style={styles.muted}>{searchQuery ? '没有匹配内容。' : '暂无传输内容，下拉可刷新。'}</Text>} renderItem={({ item }) => <View style={styles.item}><View style={styles.itemBody}><Text style={styles.itemTitle}>{item.type === 'file' ? '文件 · ' : '文本 · '}{item.title}</Text><Text style={styles.meta}>{new Date(item.created_at).toLocaleString()} {item.file_size ? `· ${formatBytes(item.file_size)}` : ''}</Text>{item.type === 'text' ? <Text style={styles.textPreview} numberOfLines={4}>{item.text_content}</Text> : null}</View><View style={styles.itemActions}>{item.type === 'file' ? <><Pressable onPress={() => void openFile(item)}><Text style={styles.linkText}>{item.mime_type?.startsWith('image/') ? '预览' : '下载'}</Text></Pressable><Pressable onPress={() => void shareFile(item)}><Text style={styles.linkText}>链接</Text></Pressable></> : <><Pressable onPress={() => setActiveText(item)}><Text style={styles.linkText}>查看</Text></Pressable><Pressable onPress={() => void copyText(item.text_content)}><Text style={styles.linkText}>复制</Text></Pressable></>}<Pressable onPress={() => deleteItem(item)}><Text style={styles.dangerText}>删除</Text></Pressable></View></View>} />
    <Modal visible={Boolean(previewUrl)} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}><View style={styles.preview}><Pressable style={styles.preview} onPress={() => setPreviewUrl(null)}>{previewUrl ? <Image source={{ uri: previewUrl }} style={styles.image} resizeMode="contain" /> : null}</Pressable></View></Modal>
    <Modal visible={Boolean(activeText)} animationType="slide" onRequestClose={() => setActiveText(null)}><SafeAreaView style={styles.textModal}><View style={styles.topRow}><Text style={styles.itemTitle}>{activeText?.title}</Text><Pressable onPress={() => setActiveText(null)}><Text style={styles.linkText}>完成</Text></Pressable></View><ScrollView><Text style={styles.fullText}>{activeText?.text_content}</Text></ScrollView><Pressable style={styles.primaryButton} onPress={() => void copyText(activeText?.text_content ?? '')}><Text style={styles.primaryText}>复制全文</Text></Pressable></SafeAreaView></Modal>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07111f', padding: 20 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: '#07111f' }, header: { marginTop: 48, gap: 8 }, topRow: { marginTop: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: '#55e0b0', fontWeight: '700' }, title: { color: '#f0f6ff', fontSize: 30, fontWeight: '800' }, muted: { color: '#9dafc4', lineHeight: 22 }, notice: { color: '#c6e6ff', backgroundColor: '#112d47', borderRadius: 10, padding: 12, marginTop: 18 }, card: { marginTop: 28, gap: 14 }, codeInput: { color: '#f0f6ff', backgroundColor: '#0e2137', borderWidth: 1, borderColor: '#3d5f80', borderRadius: 12, padding: 18, textAlign: 'center', letterSpacing: 14, fontSize: 28, fontWeight: '800' }, primaryButton: { backgroundColor: '#55e0b0', padding: 14, borderRadius: 11, alignItems: 'center', justifyContent: 'center', minHeight: 50 }, primaryText: { color: '#042219', fontWeight: '800' }, secondaryButton: { borderColor: '#496783', borderWidth: 1, padding: 14, borderRadius: 11, alignItems: 'center', minHeight: 50 }, secondaryText: { color: '#e1efff', fontWeight: '700' }, cameraWrap: { overflow: 'hidden', borderRadius: 16, marginTop: 22, gap: 12 }, camera: { height: 380 }, actions: { flexDirection: 'row', gap: 10, marginTop: 20 }, searchInput: { color: '#f0f6ff', borderColor: '#496783', borderWidth: 1, borderRadius: 11, marginTop: 12, paddingHorizontal: 14, minHeight: 46 }, list: { gap: 10, paddingVertical: 18, paddingBottom: 50 }, item: { backgroundColor: '#10233a', borderRadius: 14, padding: 14, flexDirection: 'row', gap: 10 }, itemBody: { flex: 1, gap: 5 }, itemTitle: { color: '#f0f6ff', fontWeight: '700' }, meta: { color: '#8fa6c1', fontSize: 12 }, textPreview: { color: '#d5e4f5', marginTop: 6, lineHeight: 20 }, itemActions: { alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }, linkText: { color: '#69c6ff', fontWeight: '700' }, dangerText: { color: '#ff9cab', fontWeight: '700' }, preview: { flex: 1, backgroundColor: 'rgba(0,0,0,.92)', alignItems: 'center', justifyContent: 'center' }, image: { width: '100%', height: '85%' }, textModal: { flex: 1, padding: 20, backgroundColor: '#07111f' }, fullText: { color: '#e2edf9', lineHeight: 24, paddingVertical: 20 },
});
