<?php
/**
 * ONLY for the wordpress.org screenshots taken in WordPress Playground
 * (ops/launch/obrazky/wp-snimky.mjs). Never on a real site, never inside
 * arling-asistent/.
 *
 * Playground runs in the browser, so the plugin rightly says it cannot be
 * connected there. For the screenshots:
 *   - screenshot-1 (setup screen): the "cannot be reached" warning is
 *     switched off, so the screen looks the way a live shop sees it;
 *   - screenshot-4 (ready screen): with the option arling_asistent_tenant_id
 *     set to "screenshot" by the blueprint, the status call answers "ready"
 *     for a freshly connected free shop with the products that really exist
 *     in the Playground shop. Every other call to the service is refused, so
 *     nothing is ever created on production.
 */

add_filter( 'arling_asistent_unreachable_reason', '__return_empty_string' );

add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		if ( false === strpos( $url, 'arling-asistent.arling.workers.dev' ) ) {
			return $pre;
		}
		if ( false === strpos( $url, '/v1/tenants/screenshot/status' ) ) {
			return new WP_Error( 'arling_screenshot_mode', 'Screenshot mode: calls to the service are blocked.' );
		}
		$counts = wp_count_posts( 'product' );
		$now    = time();
		$body   = array(
			'id'                 => 'screenshot',
			'domain'             => (string) wp_parse_url( home_url(), PHP_URL_HOST ),
			'plan'               => 'free',
			'status'             => 'ready',
			'monthly_quota'      => 100,
			'conversations_used' => 0,
			'usage_percent'      => 0,
			'period_start'       => gmdate( 'Y-m-01', $now ),
			'period_end'         => gmdate( 'Y-m-01', strtotime( 'first day of next month', $now ) ),
			'product_count'      => $counts ? (int) $counts->publish : 0,
			'valid_until'        => null,
			'last_ingest'        => gmdate( 'Y-m-d\TH:i:s\Z', $now - 60 ),
			'last_error'         => null,
		);
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $body ),
			'response' => array(
				'code'    => 200,
				'message' => 'OK',
			),
			'cookies'  => array(),
			'filename' => null,
		);
	},
	10,
	3
);
