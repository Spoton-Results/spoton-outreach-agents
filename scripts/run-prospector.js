/**
 * Railway start command for prospector service
 * Runs continuous prospector — never sleeps, always finding leads
 * 
 * Railway env vars to set:
 * PROSPECTOR_SLEEP_MS=300000   (5 min between batches — adjust based on API limits)
 * BATCH_SIZE=15                (prospects per batch)
 * MIN_ICP_SCORE=6              (minimum score to proceed to email)
 * INSTANTLY_CA_CAMPAIGN_ID=bb1d4655-8d06-4218-89d4-ec196bc8ca81
 * INSTANTLY_UT_CAMPAIGN_ID=1c57cd85-5694-444d-9b03-8978c628ab8d
 */
require('./prospector-continuous');
