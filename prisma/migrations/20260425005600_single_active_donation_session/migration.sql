ALTER TABLE `donation_sessions`
    ADD COLUMN `active_session_key` VARCHAR(32) NULL;

UPDATE `donation_sessions`
SET
    `status` = 'expired',
    `active_session_key` = NULL
WHERE
    `status` = 'active'
    AND `expires_at` < CURRENT_TIMESTAMP(3);

UPDATE `donation_sessions` AS `d`
JOIN (
    SELECT `donor_steam_id`, MAX(`id`) AS `keep_id`
    FROM `donation_sessions`
    WHERE `status` = 'active'
    GROUP BY `donor_steam_id`
    HAVING COUNT(*) > 1
) AS `duplicates`
    ON `d`.`donor_steam_id` = `duplicates`.`donor_steam_id`
SET
    `d`.`status` = 'expired',
    `d`.`active_session_key` = NULL
WHERE
    `d`.`id` <> `duplicates`.`keep_id`
    AND `d`.`status` = 'active';

UPDATE `donation_sessions`
SET `active_session_key` = `donor_steam_id`
WHERE `status` = 'active';

CREATE UNIQUE INDEX `donation_sessions_active_session_key_key`
    ON `donation_sessions`(`active_session_key`);
