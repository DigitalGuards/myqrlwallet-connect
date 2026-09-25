import { describe, it, expect } from 'vitest';
import {
  groupMyQrlWallet,
  isMyQrlWalletRdns,
  resolveMyQrlWalletEntry,
  MYQRLWALLET_CONNECT_RDNS,
  MYQRLWALLET_EXTENSION_LABEL,
  MYQRLWALLET_EXTENSION_RDNS,
  MYQRLWALLET_NAME,
  MYQRLWALLET_RELAY_ACTION_LABEL,
  MYQRLWALLET_RELAY_LABEL,
  type Eip6963Announcement,
} from '../src/wallets.js';

interface Detail extends Eip6963Announcement {
  provider: { id: string };
}

function announce(rdns: string, name: string, uuid = `uuid-${rdns}`): Detail {
  return {
    info: { uuid, name, icon: `icon:${rdns}`, rdns },
    provider: { id: rdns },
  };
}

const extension = announce(MYQRLWALLET_EXTENSION_RDNS, 'MyQRLWallet Extension');
const relay = announce(MYQRLWALLET_CONNECT_RDNS, 'MyQRLWallet');
const metamask = announce('io.metamask', 'MetaMask');
const qrlExtension = announce('theqrl.org', 'QRL Web3 Wallet');

describe('isMyQrlWalletRdns', () => {
  it('matches both MyQRLWallet transports', () => {
    expect(isMyQrlWalletRdns(MYQRLWALLET_EXTENSION_RDNS)).toBe(true);
    expect(isMyQrlWalletRdns(MYQRLWALLET_CONNECT_RDNS)).toBe(true);
  });

  it('leaves other wallets alone', () => {
    expect(isMyQrlWalletRdns('io.metamask')).toBe(false);
    expect(isMyQrlWalletRdns('theqrl.org')).toBe(false);
  });
});

describe('resolveMyQrlWalletEntry', () => {
  it('returns null when neither transport announced', () => {
    expect(resolveMyQrlWalletEntry([metamask, qrlExtension])).toBeNull();
  });

  it('gives the extension the primary click and relay the secondary action', () => {
    const entry = resolveMyQrlWalletEntry([relay, extension]);
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe(MYQRLWALLET_NAME);
    expect(entry?.primary).toBe('extension');
    expect(entry?.primaryLabel).toBe(MYQRLWALLET_EXTENSION_LABEL);
    expect(entry?.secondary).toBe('relay');
    expect(entry?.secondaryLabel).toBe(MYQRLWALLET_RELAY_ACTION_LABEL);
    expect(entry?.extension).toBe(extension);
    expect(entry?.relay).toBe(relay);
    expect(entry?.uuid).toBe(extension.info.uuid);
  });

  it('falls back to relay pairing when the extension is absent', () => {
    const entry = resolveMyQrlWalletEntry([relay]);
    expect(entry?.primary).toBe('relay');
    expect(entry?.primaryLabel).toBe(MYQRLWALLET_RELAY_LABEL);
    expect(entry?.secondary).toBeNull();
    expect(entry?.secondaryLabel).toBeNull();
    expect(entry?.extension).toBeUndefined();
    expect(entry?.uuid).toBe(relay.info.uuid);
  });

  it('uses the extension alone when the SDK never announced', () => {
    const entry = resolveMyQrlWalletEntry([extension]);
    expect(entry?.primary).toBe('extension');
    expect(entry?.secondary).toBeNull();
    expect(entry?.relay).toBeUndefined();
    expect(entry?.icon).toBe(extension.info.icon);
  });

  it('prefers the relay icon so the row carries the SDK wallet mark', () => {
    const entry = resolveMyQrlWalletEntry([extension, relay]);
    expect(entry?.icon).toBe(relay.info.icon);
  });

  it('honours icon and name overrides', () => {
    const entry = resolveMyQrlWalletEntry([relay], {
      icon: '/myqrlwallet-icon.svg',
      name: 'MyQRLWallet wallet',
    });
    expect(entry?.icon).toBe('/myqrlwallet-icon.svg');
    expect(entry?.name).toBe('MyQRLWallet wallet');
  });

  it('keeps the first announcement when one transport announces twice', () => {
    const second = announce(MYQRLWALLET_CONNECT_RDNS, 'MyQRLWallet', 'uuid-relay-2');
    const entry = resolveMyQrlWalletEntry([relay, second]);
    expect(entry?.relay).toBe(relay);
  });

  it('accepts any iterable, including a Map of announcements', () => {
    const map = new Map<string, Detail>([
      [relay.info.uuid, relay],
      [extension.info.uuid, extension],
    ]);
    const entry = resolveMyQrlWalletEntry(map.values());
    expect(entry?.primary).toBe('extension');
    expect(entry?.relay).toBe(relay);
  });
});

describe('groupMyQrlWallet', () => {
  it('returns one MyQRLWallet row and leaves other wallets untouched', () => {
    const entries = groupMyQrlWallet([metamask, relay, extension, qrlExtension]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'wallet', rdns: 'io.metamask', detail: metamask });
    expect(entries[1]?.kind).toBe('myqrlwallet');
    expect(entries[2]).toMatchObject({ kind: 'wallet', rdns: 'theqrl.org', detail: qrlExtension });
  });

  it('places the merged row where the first MyQRLWallet announcement was', () => {
    const entries = groupMyQrlWallet([extension, metamask, relay]);
    expect(entries.map((e) => e.kind)).toEqual(['myqrlwallet', 'wallet']);
  });

  it('passes through a list with no MyQRLWallet announcement', () => {
    const entries = groupMyQrlWallet([metamask]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('wallet');
  });

  it('returns an empty list for no announcements', () => {
    expect(groupMyQrlWallet([])).toEqual([]);
  });

  it('drops duplicate uuids among other wallets', () => {
    const twin = announce('io.metamask', 'MetaMask', metamask.info.uuid);
    const entries = groupMyQrlWallet([metamask, twin]);
    expect(entries).toHaveLength(1);
  });

  it('narrows to the merged entry so callers can read both announcements', () => {
    const entries = groupMyQrlWallet([relay, extension]);
    const first = entries[0];
    expect(first?.kind).toBe('myqrlwallet');
    if (first?.kind !== 'myqrlwallet') throw new Error('expected the merged entry');
    expect(first.extension?.provider.id).toBe(MYQRLWALLET_EXTENSION_RDNS);
    expect(first.relay?.provider.id).toBe(MYQRLWALLET_CONNECT_RDNS);
  });
});
