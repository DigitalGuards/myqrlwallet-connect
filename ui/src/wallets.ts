// Folds the two MyQRLWallet EIP-6963 announcements into a single picker row.
//
// MyQRLWallet reaches a dApp over two transports that each announce
// themselves separately: the browser extension (rdns com.qrlwallet.extension)
// and the connect SDK's relay entry for the phone, web and desktop wallets
// (rdns com.qrlwallet.connect). Left alone, a picker lists MyQRLWallet twice.
// These helpers collapse the pair into one entry that carries both
// announcements, so a picker can render one row whose primary click uses the
// extension when it is present and whose secondary action always starts relay
// pairing.
//
// Pure data. No DOM, no framework, no protocol surface.

/** rdns announced by the MyQRLWallet browser extension. */
export const MYQRLWALLET_EXTENSION_RDNS = 'com.qrlwallet.extension';

/** rdns announced by `@qrlwallet/connect` for relay pairing. */
export const MYQRLWALLET_CONNECT_RDNS = 'com.qrlwallet.connect';

/** Display name of the merged row. */
export const MYQRLWALLET_NAME = 'MyQRLWallet';

/** Secondary line when a click connects through the browser extension. */
export const MYQRLWALLET_EXTENSION_LABEL = 'Browser extension';

/** Secondary line when a click starts relay pairing. */
export const MYQRLWALLET_RELAY_LABEL = 'Phone, web or desktop';

/**
 * Accessible name for the secondary action offered when the extension holds
 * the primary click. Keep this wording aligned across dApps.
 */
export const MYQRLWALLET_RELAY_ACTION_LABEL = 'Use phone or desktop app';

/** The EIP-6963 metadata a wallet announces about itself. */
export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

/**
 * Structural subset of an EIP-6963 `announceProvider` detail. Only `info` is
 * read here; the `provider` travels along untouched on the generic type, so
 * callers keep their own detail shape.
 */
export interface Eip6963Announcement {
  info: Eip6963ProviderInfo;
}

/** Which transport a click uses. */
export type MyQrlWalletTransport = 'extension' | 'relay';

/** The single merged MyQRLWallet row. */
export interface MyQrlWalletEntry<D extends Eip6963Announcement> {
  kind: 'myqrlwallet';
  /**
   * Stable list key. This is the uuid of the announcement the primary click
   * uses, so a picker that already maps uuid to announcement keeps working
   * for the primary action.
   */
  uuid: string;
  name: string;
  icon: string;
  /** The extension announcement, present only when the extension announced. */
  extension?: D;
  /** The relay announcement, present only when the connect SDK announced. */
  relay?: D;
  /** Transport a click on the row body uses. */
  primary: MyQrlWalletTransport;
  /** Plain-text secondary line describing the primary transport. */
  primaryLabel: string;
  /** Transport of the extra action, or null when the row has only one path. */
  secondary: 'relay' | null;
  /** Accessible name of the extra action, or null when there is none. */
  secondaryLabel: string | null;
}

/** Any other announced wallet, passed through unchanged. */
export interface WalletEntry<D extends Eip6963Announcement> {
  kind: 'wallet';
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  detail: D;
}

/** One row of a wallet picker. */
export type WalletPickerEntry<D extends Eip6963Announcement> = MyQrlWalletEntry<D> | WalletEntry<D>;

export interface GroupMyQrlWalletOptions {
  /**
   * Icon for the merged row. Defaults to the relay announcement's icon (the
   * MyQRLWallet mark shipped by the SDK), falling back to the extension's.
   */
  icon?: string;
  /** Display name for the merged row. Defaults to "MyQRLWallet". */
  name?: string;
}

/** True when this rdns belongs to one of the two MyQRLWallet transports. */
export function isMyQrlWalletRdns(rdns: string): boolean {
  return rdns === MYQRLWALLET_EXTENSION_RDNS || rdns === MYQRLWALLET_CONNECT_RDNS;
}

/**
 * Builds the merged MyQRLWallet entry from a list of EIP-6963 announcements,
 * or returns null when neither MyQRLWallet transport announced.
 *
 * When both announced, the extension takes the primary click and relay
 * pairing becomes the secondary action. When only one announced, that one
 * takes the primary click and there is no secondary action. Duplicate
 * announcements for the same rdns keep the first one seen.
 */
export function resolveMyQrlWalletEntry<D extends Eip6963Announcement>(
  details: Iterable<D>,
  options: GroupMyQrlWalletOptions = {}
): MyQrlWalletEntry<D> | null {
  let extension: D | undefined;
  let relay: D | undefined;

  for (const detail of details) {
    const { rdns } = detail.info;
    if (rdns === MYQRLWALLET_EXTENSION_RDNS) {
      extension ??= detail;
    } else if (rdns === MYQRLWALLET_CONNECT_RDNS) {
      relay ??= detail;
    }
  }

  const primaryDetail = extension ?? relay;
  if (!primaryDetail) return null;

  const primary: MyQrlWalletTransport = extension ? 'extension' : 'relay';
  const hasSecondary = extension !== undefined && relay !== undefined;
  const icon = options.icon ?? relay?.info.icon ?? primaryDetail.info.icon;

  return {
    kind: 'myqrlwallet',
    uuid: primaryDetail.info.uuid,
    name: options.name ?? MYQRLWALLET_NAME,
    icon,
    ...(extension ? { extension } : {}),
    ...(relay ? { relay } : {}),
    primary,
    primaryLabel: primary === 'extension' ? MYQRLWALLET_EXTENSION_LABEL : MYQRLWALLET_RELAY_LABEL,
    secondary: hasSecondary ? 'relay' : null,
    secondaryLabel: hasSecondary ? MYQRLWALLET_RELAY_ACTION_LABEL : null,
  };
}

/**
 * Returns the picker rows for a list of EIP-6963 announcements, with the two
 * MyQRLWallet announcements folded into one entry. Every other wallet is
 * passed through in announcement order, and the merged entry sits where the
 * first MyQRLWallet announcement appeared.
 */
export function groupMyQrlWallet<D extends Eip6963Announcement>(
  details: Iterable<D>,
  options: GroupMyQrlWalletOptions = {}
): WalletPickerEntry<D>[] {
  const list = Array.from(details);
  const merged = resolveMyQrlWalletEntry(list, options);
  const entries: WalletPickerEntry<D>[] = [];
  const seenUuids = new Set<string>();
  let mergedPlaced = false;

  for (const detail of list) {
    const { uuid, name, icon, rdns } = detail.info;
    if (isMyQrlWalletRdns(rdns)) {
      if (merged && !mergedPlaced) {
        entries.push(merged);
        mergedPlaced = true;
      }
      continue;
    }
    if (seenUuids.has(uuid)) continue;
    seenUuids.add(uuid);
    entries.push({ kind: 'wallet', uuid, name, icon, rdns, detail });
  }

  if (merged && !mergedPlaced) entries.push(merged);
  return entries;
}
