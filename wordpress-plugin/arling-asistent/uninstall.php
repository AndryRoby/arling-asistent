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
 * Status transients are keyed by tenant id (arling_asistent_status_{id}),
 * so they cannot be enumerated by name. They expire on their own within
 * Arling_Asistent_Admin::STATUS_CACHE_TTL (30 seconds) regardless, but we
 * still remove the one for the tenant we just forgot above, if any, using
 * the id captured before the loop deleted it.
 */
global $wpdb;
if ( $arling_asistent_tenant_id ) {
	delete_transient( 'arling_asistent_status_' . $arling_asistent_tenant_id );
}

// Belt and braces: sweep any stray arling_asistent_status_* transients
// (and their timeout siblings) directly, in case of an id captured under
// a previous connection that was since replaced.
$wpdb->query(
	$wpdb->prepare(
		"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_arling_asistent_status_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_arling_asistent_status_' ) . '%'
	)
);
