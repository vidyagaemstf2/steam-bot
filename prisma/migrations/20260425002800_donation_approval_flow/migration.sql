CREATE TABLE `donation_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `donor_steam_id` VARCHAR(32) NOT NULL,
    `donor_name` VARCHAR(128) NULL,
    `source` ENUM('game_command', 'steam_dm') NOT NULL,
    `status` ENUM('active', 'used', 'expired') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `donation_sessions_donor_steam_id_status_expires_at_idx`(`donor_steam_id`, `status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `donation_offers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trade_offer_id` VARCHAR(64) NOT NULL,
    `donor_steam_id` VARCHAR(32) NOT NULL,
    `donor_name` VARCHAR(128) NULL,
    `message` VARCHAR(512) NULL,
    `status` ENUM('pending_review', 'approved', 'rejected', 'expired', 'accepted_failed') NOT NULL DEFAULT 'pending_review',
    `reviewed_by_id` VARCHAR(32) NULL,
    `reviewed_by_name` VARCHAR(128) NULL,
    `review_note` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,
    `accepted_at` DATETIME(3) NULL,

    UNIQUE INDEX `donation_offers_trade_offer_id_key`(`trade_offer_id`),
    INDEX `donation_offers_status_created_at_idx`(`status`, `created_at`),
    INDEX `donation_offers_donor_steam_id_status_idx`(`donor_steam_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `donation_offer_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `donation_offer_id` INTEGER NOT NULL,
    `app_id` INTEGER NOT NULL,
    `context_id` VARCHAR(32) NOT NULL,
    `asset_id` VARCHAR(256) NOT NULL,
    `class_id` VARCHAR(256) NULL,
    `instance_id` VARCHAR(256) NULL,
    `name` VARCHAR(512) NOT NULL,
    `icon_url` VARCHAR(1024) NULL,

    INDEX `donation_offer_items_donation_offer_id_idx`(`donation_offer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `prize_pool_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `asset_id` VARCHAR(256) NOT NULL,
    `item_name` VARCHAR(512) NOT NULL,
    `donor_steam_id` VARCHAR(32) NOT NULL,
    `donor_name` VARCHAR(128) NULL,
    `donation_offer_id` INTEGER NOT NULL,
    `approved_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `prize_pool_items_asset_id_key`(`asset_id`),
    INDEX `prize_pool_items_donor_steam_id_idx`(`donor_steam_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `donation_offer_items`
    ADD CONSTRAINT `donation_offer_items_donation_offer_id_fkey`
    FOREIGN KEY (`donation_offer_id`) REFERENCES `donation_offers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `prize_pool_items`
    ADD CONSTRAINT `prize_pool_items_donation_offer_id_fkey`
    FOREIGN KEY (`donation_offer_id`) REFERENCES `donation_offers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
