ALTER TABLE `pending_deliveries`
    ADD COLUMN `active_reservation_key` VARCHAR(320) NULL;

UPDATE `pending_deliveries` AS `d`
JOIN (
    SELECT
        `winner_steam_id`,
        `asset_id`,
        COALESCE(MAX(CASE WHEN `status` = 'offer_sent' THEN `id` END), MIN(`id`)) AS `keep_id`
    FROM `pending_deliveries`
    WHERE `status` IN ('pending', 'offer_sent')
    GROUP BY `winner_steam_id`, `asset_id`
    HAVING COUNT(*) > 1
) AS `duplicates`
    ON `d`.`winner_steam_id` = `duplicates`.`winner_steam_id`
    AND `d`.`asset_id` = `duplicates`.`asset_id`
SET
    `d`.`status` = 'cancelled',
    `d`.`trade_offer_id` = NULL,
    `d`.`delivered_at` = NULL
WHERE
    `d`.`id` <> `duplicates`.`keep_id`
    AND `d`.`status` IN ('pending', 'offer_sent');

UPDATE `pending_deliveries`
SET `active_reservation_key` = CONCAT(`winner_steam_id`, ':', `asset_id`)
WHERE `status` IN ('pending', 'offer_sent');

CREATE UNIQUE INDEX `pending_deliveries_active_reservation_key_key`
    ON `pending_deliveries`(`active_reservation_key`);
