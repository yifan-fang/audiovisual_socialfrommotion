# ============================================================
# Cross-modal social-from-motion: GLMM for sound × speed
# Outcome: is_fight (binary). Within-participant; speed categorical.
# ============================================================
library(lme4)
library(emmeans)
library(ez)

# ---- 1. Load -------------------------------------------------
df <- read.csv("C:/Experiments/audio_visual_socialfrommotion/pilot_experiment_data.csv", stringsAsFactors = FALSE)

# ---- 2. Set up factors --------------------------------------
df$id        <- factor(df$id)

# Sanity checks before modelling
cat("N participants:", nlevels(df$id), "\n")
cat("Trials per cell (sound × speed):\n")
print(table(df$soundCondition, df$chargeSpeed))
cat("Outcome distribution:\n"); print(table(df$is_fight))

summary(glmer('is_fight ~ soundCondition * chargeSpeed + (1|id)',
                      data=df, family=binomial(link = "logit")))

emm <- emmeans(m_full, ~ soundCondition | speed)
cat("\n=== Pairwise sound contrasts within each speed ===\n")
print(summary(contrast(emm, method = "pairwise", adjust = "holm"),
              infer = TRUE))


