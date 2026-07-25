# ממצאי כריית אנומליות — TradeSense

תאריך ריצה: 2026-07-25T10:12:28.985Z
מקור: `docs/SPEC_ANOMALY_MINING.md` (נוצר אוטומטית ע"י `node scripts/mineAnomalies.js` — נדרס בכל ריצה)

**זו אינה המלצת השקעה. עבר אינו מבטיח עתיד. ראו סעיף מגבלות בתחתית המסמך לפני הסקת מסקנות.**

## 1. פרמטרי הריצה

- בורסה: NASDAQ
- סף אירוע: 12% ביום בודד (close-to-close)
- טווח שווי שוק: 300,000,000 - 10,000,000,000
- מחיר: 2-500$, נפח דולרי חציוני מינימלי: 1,000,000$
- מקור הנפח (feed): `iex` (כיסוי חלקי של נפח השוק - ראו מגבלות)
- סימולים בטווח שווי השוק: 673 (נתונים התקבלו ל-673)
- סה"כ stock-days כשירים: 92507
- ימי מסחר ייחודיים בחלון המדידה: 253 (חיתוך in-sample/holdout בתאריך 2026-03-20T04:00:00Z)
- in-sample: 56356 שורות | holdout: 36151 שורות

## 2. Base rate

- in-sample: 0.90% (מתוך 56356 שורות)
- holdout: 0.97% (מתוך 36151 שורות)

## 3. תבניות ששרדו את שער ה-holdout

| תבנית | n (in-sample) | hits | p | lift | wilsonLB | n (holdout) | hits | p | lift | wilsonLB | סימולים ייחודיים |
|---|---|---|---|---|---|---|---|---|---|---|---|
| highProximity60d in [-inf, 0.779) AND priceVsMa50 in [0.091, +inf) | 510 | 31 | 6.08% | 6.78 | 0.043 | 370 | 26 | 7.03% | 7.28 | 0.048 | 14 |
| gapCount10d >= 3 AND priceVsMa50 in [0.091, +inf) | 1961 | 101 | 5.15% | 5.75 | 0.043 | 2286 | 98 | 4.29% | 4.44 | 0.035 | 34 |
| gapCount10d >= 3 AND volumeRatio3d in [1.182, +inf) | 1225 | 65 | 5.31% | 5.92 | 0.042 | 1371 | 55 | 4.01% | 4.16 | 0.031 | 31 |
| distFromLow60d in [0.358, +inf) AND gapCount10d >= 3 | 2570 | 122 | 4.75% | 5.30 | 0.040 | 3030 | 120 | 3.96% | 4.10 | 0.033 | 35 |
| gapCount10d >= 3 AND priceVsMa200 in [0.272, +inf) | 2526 | 120 | 4.75% | 5.30 | 0.040 | 2618 | 107 | 4.09% | 4.23 | 0.034 | 32 |
| gapCount10d >= 3 AND rangePosition20d in [0.486, 0.773) | 1117 | 56 | 5.01% | 5.59 | 0.039 | 1316 | 41 | 3.12% | 3.23 | 0.023 | 27 |
| adrContraction in [1.150, +inf) AND gapCount10d >= 3 | 1260 | 62 | 4.92% | 5.49 | 0.039 | 1220 | 45 | 3.69% | 3.82 | 0.028 | 31 |
| gapCount10d >= 3 AND volumeRatio1d in [1.208, +inf) | 1147 | 57 | 4.97% | 5.55 | 0.039 | 1376 | 62 | 4.51% | 4.67 | 0.035 | 30 |
| gapCount10d >= 3 AND return20d in [0.094, +inf) | 1902 | 89 | 4.68% | 5.22 | 0.038 | 2172 | 79 | 3.64% | 3.77 | 0.029 | 29 |
| gapCount10d >= 3 AND volumeTrend5d in [1.241, +inf) | 1343 | 65 | 4.84% | 5.40 | 0.038 | 1385 | 49 | 3.54% | 3.66 | 0.027 | 31 |
| gapCount10d >= 3 AND ma50Slope in [0.018, +inf) | 2325 | 106 | 4.56% | 5.09 | 0.038 | 2530 | 103 | 4.07% | 4.22 | 0.034 | 33 |
| adrPct20d in [4.848, +inf) AND volumeRatio3d in [1.182, +inf) | 3229 | 143 | 4.43% | 4.94 | 0.038 | 2945 | 87 | 2.95% | 3.06 | 0.024 | 68 |
| distFromLow60d in [0.358, +inf) AND highProximity60d in [-inf, 0.779) | 1713 | 76 | 4.44% | 4.95 | 0.036 | 1254 | 56 | 4.47% | 4.63 | 0.035 | 31 |
| adrContraction in [1.150, +inf) AND adrPct20d in [4.848, +inf) | 3269 | 137 | 4.19% | 4.68 | 0.036 | 2632 | 77 | 2.93% | 3.03 | 0.023 | 66 |
| adrPct20d in [4.848, +inf) AND volumeRatio1d in [1.208, +inf) | 3145 | 130 | 4.13% | 4.61 | 0.035 | 2888 | 116 | 4.02% | 4.16 | 0.034 | 72 |
| distFromLow60d in [0.358, +inf) AND priceVsMa50 in [-inf, -0.071) | 425 | 22 | 5.18% | 5.78 | 0.034 | 347 | 13 | 3.75% | 3.88 | 0.022 | 14 |
| adrPct20d in [4.848, +inf) AND volumeTrend5d in [1.241, +inf) | 3331 | 134 | 4.02% | 4.49 | 0.034 | 2920 | 83 | 2.84% | 2.94 | 0.023 | 65 |
| highProximity60d in [-inf, 0.779) AND priceVsMa200 in [0.272, +inf) | 1774 | 75 | 4.23% | 4.72 | 0.034 | 1013 | 50 | 4.94% | 5.11 | 0.038 | 29 |
| highProximity60d in [0.779, 0.876) AND priceVsMa50 in [0.091, +inf) | 1573 | 67 | 4.26% | 4.75 | 0.034 | 1308 | 40 | 3.06% | 3.17 | 0.023 | 35 |
| highProximity60d in [-inf, 0.779) AND ma50Slope in [0.018, +inf) | 1238 | 52 | 4.20% | 4.69 | 0.032 | 880 | 44 | 5.00% | 5.18 | 0.037 | 24 |

## 4. תבניות שנפלו בשער ה-holdout

חובה להציג את הטבלה הזו — היא העדות המרכזית על מידת ה-overfitting בשלב הגילוי.

(אין - כל התבניות שעברו את שלב הגילוי גם שרדו את ה-holdout, או שלא נמצאה אף תבנית בשלב הגילוי.)

## 5. הצלבה מול היום — מי עומד בקריטריון כעת

רשימת סימולים בלבד, ללא דירוג וללא ציון "מומלץ ביותר" — ראו סעיף 0.4 במסמך האיפיון.

**highProximity60d in [-inf, 0.779) AND priceVsMa50 in [0.091, +inf)** (holdout: 7.03% על 370 מופעים, lift 7.28)
- MAAS
- FSLY
- QURE
- SLS

**gapCount10d >= 3 AND priceVsMa50 in [0.091, +inf)** (holdout: 4.29% על 2286 מופעים, lift 4.44)
- MAAS
- TDTH
- GSHD
- RVMDW

**gapCount10d >= 3 AND volumeRatio3d in [1.182, +inf)** (holdout: 4.01% על 1371 מופעים, lift 4.16)
- MXL
- RGEN
- RIOT
- VICR
- BELFA
- PEGA
- QS
- WIX
- BRZE
- FFAI
- NVCR
- NBTX
- APPN

**distFromLow60d in [0.358, +inf) AND gapCount10d >= 3** (holdout: 3.96% על 3030 מופעים, lift 4.10)
- ACMR
- CIFR
- MAAS
- MRCY
- RIOT
- SIMO
- SEZL
- CHRN
- ICHR
- TDTH
- GSHD
- KEEL
- NVCR
- PENG
- OUST
- RVMDW
- FCEL

**gapCount10d >= 3 AND priceVsMa200 in [0.272, +inf)** (holdout: 4.09% על 2618 מופעים, lift 4.23)
- ACMR
- CORZW
- MAAS
- KLIC
- MXL
- SIMO
- SEZL
- CHRN
- ICHR
- LASR
- UCTT
- AEHR
- COHU
- IMOS
- NVCR
- NBTX
- PENG
- PDFS
- RVMDW
- FCEL
- ATLC

**gapCount10d >= 3 AND rangePosition20d in [0.486, 0.773)** (holdout: 3.12% על 1316 מופעים, lift 3.23)
- CAMT
- CORZW
- CIFR
- CLSK
- LASR
- WIX
- NBTX
- PLAB
- RVMDW

**adrContraction in [1.150, +inf) AND gapCount10d >= 3** (holdout: 3.69% על 1220 מופעים, lift 3.82)
- CIFR
- RGEN
- AEHR
- BRZE
- FFAI
- GSHD
- NVCR
- VERX
- APPN

**gapCount10d >= 3 AND volumeRatio1d in [1.208, +inf)** (holdout: 4.51% על 1376 מופעים, lift 4.67)
- MXL
- RGEN
- VICR
- AUGO
- BELFA
- POWI
- QS
- WIX
- FFAI
- GSHD
- NVCR

**gapCount10d >= 3 AND return20d in [0.094, +inf)** (holdout: 3.64% על 2172 מופעים, lift 3.77)
- LASR
- TDTH
- WIX
- BRZE
- GSHD
- NVCR
- NBTX
- VERX
- APPN

**gapCount10d >= 3 AND volumeTrend5d in [1.241, +inf)** (holdout: 3.54% על 1385 מופעים, lift 3.66)
- CIFR
- MXL
- RGEN
- RIOT
- VICR
- BELFA
- PEGA
- QS
- USAR
- WIX
- BRZE
- FFAI
- NVCR
- NBTX
- PLBL
- APPN

**gapCount10d >= 3 AND ma50Slope in [0.018, +inf)** (holdout: 4.07% על 2530 מופעים, lift 4.22)
- ACMR
- MAAS
- SEZL
- CHRN
- ICHR
- TDTH
- GSHD
- PENG
- OUST
- RVMDW
- FCEL
- ATLC

**adrPct20d in [4.848, +inf) AND volumeRatio3d in [1.182, +inf)** (holdout: 2.95% על 2945 מופעים, lift 3.06)
- LQDA
- MBLY
- MXL
- RIOT
- VICR
- COCO
- DYN
- MNDY
- PONY
- QS
- XMTR
- WIX
- BRZE
- FFAI
- NVCR
- PLSE
- SOUN
- SION
- FIVN

**distFromLow60d in [0.358, +inf) AND highProximity60d in [-inf, 0.779)** (holdout: 4.47% על 1254 מופעים, lift 4.63)
- ACMR
- CIFR
- MAAS
- RIOT
- SIMO
- ALHC
- CHRN
- ICHR
- NTSK
- PTRN
- TENB
- TNGX
- BAND
- CLOV
- KEEL
- INOD
- PENG
- OUST
- QURE
- SLS
- FCEL
- ABCL
- CMPS

**adrContraction in [1.150, +inf) AND adrPct20d in [4.848, +inf)** (holdout: 2.93% על 2632 מופעים, lift 3.03)
- CIFR
- LQDA
- MBLY
- TTAN
- COCO
- MNDY
- PTRN
- ONDS
- XMTR
- AEHR
- BRZE
- FFAI
- GSHD
- NVCR
- PLSE
- PVLA
- VERX
- FIVN

**adrPct20d in [4.848, +inf) AND volumeRatio1d in [1.208, +inf)** (holdout: 4.02% על 2888 מופעים, lift 4.16)
- MBLY
- MXL
- VICR
- AUGO
- CAI
- DYN
- MNDY
- PONY
- QS
- XMTR
- WIX
- BEAM
- FFAI
- GSHD
- JBLU
- NVCR
- SOUN
- SEDG
- SION
- FIVN
- NN

**distFromLow60d in [0.358, +inf) AND priceVsMa50 in [-inf, -0.071)** (holdout: 3.75% על 347 מופעים, lift 3.88)
- RIOT
- KEEL
- INOD
- PENG
- OUST
- ABCL
- CMPS

**adrPct20d in [4.848, +inf) AND volumeTrend5d in [1.241, +inf)** (holdout: 2.84% על 2920 מופעים, lift 2.94)
- CIFR
- MBLY
- MXL
- RIOT
- VICR
- COCO
- DYN
- MNDY
- PONY
- QS
- ONDS
- XMTR
- USAR
- WIX
- BRZE
- FFAI
- NVCR
- PLBL
- SOUN
- SION
- FIVN

**highProximity60d in [-inf, 0.779) AND priceVsMa200 in [0.272, +inf)** (holdout: 4.94% על 1013 מופעים, lift 5.11)
- ACMR
- CORZW
- MAAS
- KLIC
- MXL
- SIMO
- VSAT
- CHRN
- ICHR
- PTRN
- TENB
- TNGX
- UCTT
- ASTH
- BAND
- AEHR
- CLOV
- COHU
- IMOS
- NBTX
- PENG
- PDFS
- QURE
- SLS
- FCEL
- CMPS
- TH

**highProximity60d in [0.779, 0.876) AND priceVsMa50 in [0.091, +inf)** (holdout: 3.06% על 1308 מופעים, lift 3.17)
- KYMR
- QLYS
- TWST
- FA
- GPCR
- TDTH
- ATEX
- BCAX
- NWL
- PVLA
- TRVI
- DMRA
- EYE

**highProximity60d in [-inf, 0.779) AND ma50Slope in [0.018, +inf)** (holdout: 5.00% על 880 מופעים, lift 5.18)
- ACMR
- MAAS
- SAIL
- CHRN
- ICHR
- PTRN
- TENB
- BAND
- CLOV
- PENG
- OUST
- QURE
- SLS
- FCEL

## 6. מגבלות (לקרוא לפני הסקת מסקנות)

- **נפח מ-feed=iex.** הנפח בברים הוא נפח IEX בלבד (כ-2-3% מהנפח המאוחד), לא נפח השוק המלא. מכיוון שהסיגנל המרכזי הנבדק כאן הוא לרוב אנומליית נפח, זו המגבלה החמורה ביותר בדוח הזה.
- **הטיית שרידות (survivorship bias).** רשימת הסימולים מבוססת נכסים פעילים בלבד כיום - מניה שקפצה ואז נמחקה מהמסחר אינה חלק מהמדגם.
- **הטיית שווי שוק לא-point-in-time.** סינון הטווח (300M-10B) מבוסס שווי השוק של היום, לא של בזמן המדידה - מניה שהייתה קטנה יותר וקפצה נראית "בטווח" גם אם לא הייתה כזו בזמן האמת.
- **הדרת הנפקות טריות.** נדרשים לפחות 210 ברים לפני כל שורה - מניות IPO טריות אינן חלק מהמדגם.
- **תצפיות לא בלתי-תלויות (clustering).** מספר "hits" של תבנית יכול להתרכז בכמה סימולים/ימים קרובים - מטופל חלקית ע"י מסנני הריכוזיות בשלב הגילוי (סעיף 6.4), אך לא מתוקן סטטיסטית באופן מלא.
- **עבר אינו מבטיח עתיד. זו אינה המלצת השקעה, לא דירוג מניות, ולא ציון הסתברות מכויל.**
