/** The deployment as its wrangler configs say (deployment.ts, read at build time). */
declare module "virtual:deployment" {
	const deployment: import("../deployment").Deployment;

	export default deployment;
}
