library(lme4)
library(lmerTest)
library(emmeans)
library(dplyr)
library(tidyr)

# ---- Load -------------------------------------------------
df <- read.csv("C:/Experiments/audio_visual_socialfrommotion/exp1_experiment_data.csv", stringsAsFactors = FALSE)

# ---- Set up factors --------------------------------------
df$id        <- factor(df$id)
df$soundCondition <- factor(df$soundCondition)
df$sound_aware <- factor(df$sound_aware)

# Sanity checks before modelling
cat("N participants:", nlevels(df$id), "\n")
cat("Trials per cell (sound × speed):\n")
print(table(df$soundCondition, df$chargeSpeed))
cat("Outcome distribution:\n"); print(table(df$is_fight))

# ---- Model --------------------------------------
df$soundCondition <- relevel(df$soundCondition, ref = "higher")
model <- lmer(is_fight ~ soundCondition + chargeSpeed + (1|id),
              data = df)
summary(model)

emm <- emmeans(model, ~ soundCondition)
pairs(emm)

# ---- Quadratic model --------------------------------------
qua_model <- lmer(is_fight ~ soundCondition*poly(chargeSpeed, 2) + (1|id),
              data = df)
summary(qua_model)


# ---- Confidence model --------------------------------------
conf_model <- lmer(confidence ~ poly(chargeSpeed, 2) * soundCondition + (1|id),
                   data = df)
summary(conf_model)

# ---- Model accounting for sound awareness --------------------------------------
sound_awareness_model <- lmer(is_fight ~ soundCondition + chargeSpeed + sound_aware + sound_aware*soundCondition + (1|id),
              data = df)
summary(sound_awareness_model)

# ---- Sound difference model --------------------------------------
cell <- df %>%
  group_by(id, soundCondition, chargeSpeed) %>%
  summarise(p      = mean(is_fight),
            conf   = mean(confidence),
            k      = sum(is_fight),      # for the empirical logit
            n      = n(),
            .groups = "drop") %>%
  mutate(elogit = log((k + 0.5) / (n - k + 0.5)))

wide <- cell %>%
  pivot_wider(id_cols     = c(id, chargeSpeed),
              names_from  = soundCondition,
              values_from = c(p, conf, elogit))

diff <- wide %>%
  transmute(id, chargeSpeed,
            is_fight_diff   = p_higher      - p_lower,
            confidence_diff = conf_higher   - conf_lower,
            elogit_diff     = elogit_higher - elogit_lower)


diff$id <- factor(diff$id)
pc <- poly(diff$chargeSpeed, 2)
diff$speed_lin  <- pc[, 1]
diff$speed_quad <- pc[, 2]

m_diff <- lmer(is_fight_diff ~ speed_lin + speed_quad + (1 | id), data = diff)
summary(m_diff)

m_elogit <- lmer(elogit_diff ~ speed_lin + speed_quad + (1 | id), data = diff)
summary(m_elogit)
