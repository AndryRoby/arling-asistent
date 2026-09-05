<?php
/**
 * Uninstall handler: removes every option this plugin created. WordPress
 * only ever runs this file when a user clicks "Delete" on the plugin from
 * wp-admin (never on plain deactivation), and only after confirming.
 *
 * No remote request is made here: disconnecting does not delete the tenant
 * record on ARLing's servers (see class-arling-asistent-admin.php
 * "Disconnect" section), it only stops the local site from being
 * associated with it going forward. A merchant who wants their tenant data
 * removed from ARLing's servers should contact andrej@arling.sk or use the
 * Data Processing Agreement contact, as disclosed on the settings page.
 *
 * @package Arling_Asistent
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

// Capture the tenant id before the option is deleted below, so its status
// transient can be cleaned up too.
$arling_asistent_tenant_id = get_option( 'arling_asistent_tenant_id' );

$arling_asistent_options = array(
	'arling_asistent_tenant_id',
	'arling_asistent_domain',
	'arling_asistent_email',
	'arling_asistent_connected_at',
	'arling_asistent_lang',
	'arling_asistent_color',
	'arling_asistent_position',
	'arling_asistent_display_scope',
);

foreach ( $arling_asistent_options as $arling_asistent_option ) {
	delete_option( $arling_asistent_option );
	// Multisite: also clean up per-site options if this was network-activated.
	delete_site_option( $arling_asistent_option );
}

/*
 * The status transient is keyed by tenant id (arling_asistent_status_{id}),
 * so remove the one for the tenant we just forgot above, using the id
 * captured before the loop deleted it. Any other stray transient from an
 * id that is no longer connected (e.g. disconnect followed by a fresh
 * connect under a new id) is not queried for directly here (that would
 * need a direct database query, which uninstall.php should avoid): it
 * expires on its own within Arling_Asistent_Admin::STATUS_CACHE_TTL, 30
 * seconds, regardless.
 */
if ( $arling_asistent_tenant_id ) {
	delete_transient( 'arling_asistent_status_' . $arling_asistent_tenant_id );
}
