/** @jsxImportSource preact */
/**
 * Your account, in a dialog over the editor (packages/account, the admin app's page too): how you sign in, a password,
 * two-factor. Loaded only when opened, so its QR code renderer stays out of the shell's bundle.
 */
import "theme/components/dialog";
import "theme/components/callout";
import "theme/components/spinner";
import "theme/exceptions/account.css";
import { AccountPage } from "account";
import { accountApi } from "./session";

export function AccountDialog({ onClose }: { "onClose": () => void }) {
	return (
		<wa-dialog
			open
			class="account-dialog"
			label="Your account"
			onwa-after-hide={(event: Event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<AccountPage api={accountApi} heading={false} />
		</wa-dialog>
	);
}
