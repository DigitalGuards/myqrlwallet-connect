// The wallet a request is waiting for, and the hint's wording. Plain data and
// functions with no DOM, so this module also loads during server-side
// rendering. The element that shows the hint lives in approval.ts.
//
// The wallet's name and icon come from its own EIP-6963 announcement, which
// is untrusted input.

import { MYQRLWALLET_CONNECT_RDNS, MYQRLWALLET_NAME, type Eip6963ProviderInfo } from './wallets.js';

/**
 * Where the wallet lives. `extension`: in this browser. `paired`: on another
 * device or app, reached through relay pairing.
 */
export type ApprovalWalletKind = 'extension' | 'paired';

/** The wallet a request is waiting for. */
export interface ApprovalWallet {
  /** Display name, shown as text. */
  readonly name: string;
  /** The wallet's icon as an image data URI, or null for the neutral glyph. */
  readonly icon: string | null;
  readonly kind: ApprovalWalletKind;
}

/** The two lines of the hint. Exported for dApps that render their own. */
export interface ApprovalHintText {
  readonly title: string;
  readonly detail: string;
}

const MAX_NAME_LENGTH = 40;
/** An icon above this length is dropped: a wallet icon is a few kilobytes. */
const MAX_ICON_LENGTH = 262_144;
const IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i;
/** Control and format characters, among them the bidirectional overrides. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** True for an icon the hint will render: an image data URI of a sane size and nothing else. */
export const isApprovalIcon = (icon: unknown): icon is string =>
  typeof icon === 'string' && icon.length <= MAX_ICON_LENGTH && IMAGE_DATA_URI.test(icon);

function displayName(name: unknown): string {
  const clean = typeof name === 'string' ? name.replace(INVISIBLE, '').trim() : '';
  if (clean === '') return 'your wallet';
  const points = Array.from(clean);
  return points.length > MAX_NAME_LENGTH ? `${points.slice(0, MAX_NAME_LENGTH).join('')}…` : clean;
}

/** The wallet behind an EIP-6963 announcement, as the hint needs it. */
export function approvalWalletFor(info: Eip6963ProviderInfo): ApprovalWallet {
  const paired = info.rdns === MYQRLWALLET_CONNECT_RDNS;
  // An announcement is untrusted input: the fields may be anything.
  const announced: unknown = info.name;
  return {
    name: paired ? MYQRLWALLET_NAME : typeof announced === 'string' ? announced : '',
    icon: isApprovalIcon(info.icon) ? info.icon : null,
    kind: paired ? 'paired' : 'extension',
  };
}

/** The hint's wording for a wallet. */
export function approvalHintText(wallet: Pick<ApprovalWallet, 'name' | 'kind'>): ApprovalHintText {
  const name = displayName(wallet.name);
  return wallet.kind === 'paired'
    ? {
        title: `Waiting for ${name}`,
        detail: `Approve this request in ${name} on the device you paired.`,
      }
    : {
        title: `Waiting for ${name}`,
        detail: `Open ${name} to approve this request. Its icon in the browser toolbar may show a small number.`,
      };
}
