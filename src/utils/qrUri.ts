export interface QRConnectParams {
  channelId: string;
  pubKey: string;
  name: string;
  url: string;
  icon?: string;
  chainId: string;
  relayUrl: string;
}

/**
 * Generate a qrlconnect:// URI for QR code or deep link.
 */
export function generateConnectionURI(params: QRConnectParams): string {
  const searchParams = new URLSearchParams({
    channelId: params.channelId,
    pubKey: params.pubKey,
    name: params.name,
    url: params.url,
    chainId: params.chainId,
    relay: params.relayUrl,
  });

  if (params.icon) {
    searchParams.set('icon', params.icon);
  }

  return `qrlconnect://?${searchParams.toString()}`;
}

/**
 * Parse a qrlconnect:// URI back into its components.
 */
export function parseConnectionURI(uri: string): QRConnectParams | null {
  try {
    // Handle both qrlconnect://? and qrlconnect:? formats
    const queryString = uri.replace(/^qrlconnect:\/?\/?/, '');
    const params = new URLSearchParams(queryString);

    const channelId = params.get('channelId');
    const pubKey = params.get('pubKey');
    const name = params.get('name');
    const url = params.get('url');
    const chainId = params.get('chainId');
    const relayUrl = params.get('relay');

    if (!channelId || !pubKey || !name || !url || !chainId || !relayUrl) {
      return null;
    }

    return {
      channelId,
      pubKey,
      name,
      url,
      icon: params.get('icon') || undefined,
      chainId,
      relayUrl,
    };
  } catch {
    return null;
  }
}
