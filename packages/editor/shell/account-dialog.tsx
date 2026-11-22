/** @jsxImportSource preact */
import "theme/components/dialog";
import "theme/components/callout";
import "theme/components/spinner";
import { accountStyles } from "theme/styles/account";
import { AccountPage } from "account";
import { accountApi } from "./session";

accountStyles();

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
