// WalletConnect v2 for the wallet picker. Bundled to public/wc.js and loaded only when someone picks WalletConnect.
// The QR code is drawn here (qrcode-generator); Reown's own modal (@reown/appkit) is left out of the bundle.
import { EthereumProvider } from '@walletconnect/ethereum-provider';
import qrcode from 'qrcode-generator';
export { EthereumProvider };
export function qrDataUrl(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 2); }
