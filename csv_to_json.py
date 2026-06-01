import pandas as pd, json
df = pd.read_csv('trial_metadata.csv')
print("export const trialMetadata = " + df.to_json(orient='records') + ";")