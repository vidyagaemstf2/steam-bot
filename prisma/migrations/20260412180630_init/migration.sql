-- CreateTable
CREATE TABLE `pending_deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `winner_steam_id` VARCHAR(32) NOT NULL,
    `asset_id` VARCHAR(256) NOT NULL,
    `item_name` VARCHAR(512) NOT NULL,
    `status` ENUM('pending', 'offer_sent', 'delivered', 'cancelled') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delivered_at` DATETIME(3) NULL,
    `trade_offer_id` VARCHAR(64) NULL,

    INDEX `pending_deliveries_winner_steam_id_status_idx`(`winner_steam_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
