ALTER TABLE `prize_pool_items`
    DROP FOREIGN KEY `prize_pool_items_donation_offer_id_fkey`;

ALTER TABLE `prize_pool_items`
    MODIFY COLUMN `donation_offer_id` INTEGER NULL;

ALTER TABLE `prize_pool_items`
    ADD COLUMN `price_keys`     DOUBLE NULL,
    ADD COLUMN `price_metal`    DOUBLE NULL,
    ADD COLUMN `price_in_metal` DOUBLE NULL,
    ADD COLUMN `priced_at`      DATETIME(3) NULL;

ALTER TABLE `prize_pool_items`
    ADD CONSTRAINT `prize_pool_items_donation_offer_id_fkey`
    FOREIGN KEY (`donation_offer_id`) REFERENCES `donation_offers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
