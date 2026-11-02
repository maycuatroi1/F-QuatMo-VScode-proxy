/**
 * Auto-generated Authoritative Session Metadata for SS-6X47 and SS-QLHK.
 * Generated on 2026-11-02T07:44:15.656Z
 */

export interface StudentMetaRecord {
  studentId: string;
  hasLoggedIn: boolean;
  trueSignin: number;
  trueExpire: number;
  tokensConsumed: number;
  promptCount: number;
  latestClassification: string;
  inWindowEvents: number;
  preSessionFiltered: number;
  postSessionFiltered: number;
  uploadIp: string;
}

export interface SessionMetaRecord {
  sessionCode: string;
  examDateStr: string;
  createdAt: number;
  durationMinutes: number;
  students: StudentMetaRecord[];
}

export const SESSIONS_META: Record<string, SessionMetaRecord> = {
  "SS-6X47": {
    "sessionCode": "SS-6X47",
    "examDateStr": "2026-10-06",
    "createdAt": 1791250551391,
    "durationMinutes": 120,
    "students": [
      {
        "studentId": "DATTT67",
        "hasLoggedIn": true,
        "trueSignin": 1791250576817,
        "trueExpire": 1791262674000,
        "tokensConsumed": 80101,
        "promptCount": 22,
        "latestClassification": "mixed",
        "inWindowEvents": 2514,
        "preSessionFiltered": 1908,
        "postSessionFiltered": 0,
        "uploadIp": "116.96.44.31"
      },
      {
        "studentId": "HE172034",
        "hasLoggedIn": true,
        "trueSignin": 1791256456624,
        "trueExpire": 1791262436681,
        "tokensConsumed": 0,
        "promptCount": 0,
        "latestClassification": "none",
        "inWindowEvents": 2229,
        "preSessionFiltered": 0,
        "postSessionFiltered": 16,
        "uploadIp": "58.186.240.13"
      },
      {
        "studentId": "HE186629",
        "hasLoggedIn": true,
        "trueSignin": 1791256408011,
        "trueExpire": 1791262258000,
        "tokensConsumed": 45382,
        "promptCount": 12,
        "latestClassification": "mixed",
        "inWindowEvents": 2558,
        "preSessionFiltered": 3419,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE200039",
        "hasLoggedIn": true,
        "trueSignin": 1791256286743,
        "trueExpire": 1791262898000,
        "tokensConsumed": 7097,
        "promptCount": 1,
        "latestClassification": "mixed",
        "inWindowEvents": 2604,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE200333",
        "hasLoggedIn": true,
        "trueSignin": 1791255970433,
        "trueExpire": 1791262739483,
        "tokensConsumed": 52794,
        "promptCount": 7,
        "latestClassification": "mixed",
        "inWindowEvents": 1538,
        "preSessionFiltered": 0,
        "postSessionFiltered": 21,
        "uploadIp": "58.186.240.6"
      },
      {
        "studentId": "HE200637",
        "hasLoggedIn": true,
        "trueSignin": 1791256074003,
        "trueExpire": 1791262267000,
        "tokensConsumed": 79046,
        "promptCount": 18,
        "latestClassification": "mixed",
        "inWindowEvents": 3203,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.232"
      },
      {
        "studentId": "HE200673",
        "hasLoggedIn": true,
        "trueSignin": 1791256591051,
        "trueExpire": 1791261871000,
        "tokensConsumed": 14008,
        "promptCount": 3,
        "latestClassification": "mixed",
        "inWindowEvents": 800,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.1"
      },
      {
        "studentId": "HE200736",
        "hasLoggedIn": true,
        "trueSignin": 1791256099944,
        "trueExpire": 1791263032000,
        "tokensConsumed": 5968,
        "promptCount": 3,
        "latestClassification": "mixed",
        "inWindowEvents": 1840,
        "preSessionFiltered": 2457,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE200785",
        "hasLoggedIn": true,
        "trueSignin": 1791256148313,
        "trueExpire": 1791262779000,
        "tokensConsumed": 68879,
        "promptCount": 18,
        "latestClassification": "mixed",
        "inWindowEvents": 1809,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE200854",
        "hasLoggedIn": true,
        "trueSignin": 1791256538241,
        "trueExpire": 1791262307761,
        "tokensConsumed": 40314,
        "promptCount": 8,
        "latestClassification": "mixed",
        "inWindowEvents": 830,
        "preSessionFiltered": 0,
        "postSessionFiltered": 11,
        "uploadIp": "104.28.243.58"
      },
      {
        "studentId": "HE201042",
        "hasLoggedIn": true,
        "trueSignin": 1791256188533,
        "trueExpire": 1791262918266,
        "tokensConsumed": 60505,
        "promptCount": 9,
        "latestClassification": "mixed",
        "inWindowEvents": 2359,
        "preSessionFiltered": 0,
        "postSessionFiltered": 128,
        "uploadIp": "58.186.240.12"
      },
      {
        "studentId": "HE201163",
        "hasLoggedIn": true,
        "trueSignin": 1791256595495,
        "trueExpire": 1791263046000,
        "tokensConsumed": 12069,
        "promptCount": 4,
        "latestClassification": "mixed",
        "inWindowEvents": 1703,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.230"
      },
      {
        "studentId": "HE201200",
        "hasLoggedIn": true,
        "trueSignin": 1791256188723,
        "trueExpire": 1791262612000,
        "tokensConsumed": 78017,
        "promptCount": 19,
        "latestClassification": "mixed",
        "inWindowEvents": 1738,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.4"
      },
      {
        "studentId": "HE201256",
        "hasLoggedIn": true,
        "trueSignin": 1791255962420,
        "trueExpire": 1791262803735,
        "tokensConsumed": 54061,
        "promptCount": 7,
        "latestClassification": "mixed",
        "inWindowEvents": 1919,
        "preSessionFiltered": 2508,
        "postSessionFiltered": 17,
        "uploadIp": "118.70.211.228"
      },
      {
        "studentId": "HE201724",
        "hasLoggedIn": true,
        "trueSignin": 1791256006329,
        "trueExpire": 1791262697000,
        "tokensConsumed": 0,
        "promptCount": 0,
        "latestClassification": "none",
        "inWindowEvents": 1412,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE204083",
        "hasLoggedIn": true,
        "trueSignin": 1791256587628,
        "trueExpire": 1791262706000,
        "tokensConsumed": 61664,
        "promptCount": 19,
        "latestClassification": "mixed",
        "inWindowEvents": 1605,
        "preSessionFiltered": 1723,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.5"
      },
      {
        "studentId": "HE204089",
        "hasLoggedIn": true,
        "trueSignin": 1791255993312,
        "trueExpire": 1791262703000,
        "tokensConsumed": 148486,
        "promptCount": 33,
        "latestClassification": "mixed",
        "inWindowEvents": 2910,
        "preSessionFiltered": 3216,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE204798",
        "hasLoggedIn": true,
        "trueSignin": 1791256756932,
        "trueExpire": 1791257973404,
        "tokensConsumed": 21048,
        "promptCount": 4,
        "latestClassification": "mixed",
        "inWindowEvents": 127,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": ""
      },
      {
        "studentId": "SE203813",
        "hasLoggedIn": true,
        "trueSignin": 1791255948189,
        "trueExpire": 1791264052666,
        "tokensConsumed": 161226,
        "promptCount": 42,
        "latestClassification": "mixed",
        "inWindowEvents": 4340,
        "preSessionFiltered": 0,
        "postSessionFiltered": 13,
        "uploadIp": "118.70.211.230"
      }
    ]
  },
  "SS-QLHK": {
    "sessionCode": "SS-QLHK",
    "examDateStr": "2026-09-24",
    "createdAt": 1790180968564,
    "durationMinutes": 120,
    "students": [
      {
        "studentId": "DATTT67",
        "hasLoggedIn": true,
        "trueSignin": 1790211083895,
        "trueExpire": 1790217478000,
        "tokensConsumed": 0,
        "promptCount": 0,
        "latestClassification": "none",
        "inWindowEvents": 111,
        "preSessionFiltered": 1453,
        "postSessionFiltered": 0,
        "uploadIp": "116.96.45.178"
      },
      {
        "studentId": "HE172034",
        "hasLoggedIn": true,
        "trueSignin": 1790211318547,
        "trueExpire": 1790217057000,
        "tokensConsumed": 0,
        "promptCount": 0,
        "latestClassification": "none",
        "inWindowEvents": 2000,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.13"
      },
      {
        "studentId": "HE186629",
        "hasLoggedIn": true,
        "trueSignin": 1790210204063,
        "trueExpire": 1790216634000,
        "tokensConsumed": 14280,
        "promptCount": 4,
        "latestClassification": "mixed",
        "inWindowEvents": 3216,
        "preSessionFiltered": 30,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE200039",
        "hasLoggedIn": true,
        "trueSignin": 1790212413609,
        "trueExpire": 1790216849000,
        "tokensConsumed": 15360,
        "promptCount": 6,
        "latestClassification": "mixed",
        "inWindowEvents": 1929,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE200333",
        "hasLoggedIn": true,
        "trueSignin": 1790211122891,
        "trueExpire": 1790217596000,
        "tokensConsumed": 25552,
        "promptCount": 8,
        "latestClassification": "mixed",
        "inWindowEvents": 1839,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.6"
      },
      {
        "studentId": "HE200473",
        "hasLoggedIn": true,
        "trueSignin": 1790211643416,
        "trueExpire": 1790216755000,
        "tokensConsumed": 65639,
        "promptCount": 14,
        "latestClassification": "mixed",
        "inWindowEvents": 1685,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.8"
      },
      {
        "studentId": "HE200637",
        "hasLoggedIn": true,
        "trueSignin": 1790211026575,
        "trueExpire": 1790216351000,
        "tokensConsumed": 27963,
        "promptCount": 9,
        "latestClassification": "mixed",
        "inWindowEvents": 1970,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.232"
      },
      {
        "studentId": "HE200673",
        "hasLoggedIn": true,
        "trueSignin": 1790211312264,
        "trueExpire": 1790216779000,
        "tokensConsumed": 32270,
        "promptCount": 8,
        "latestClassification": "mixed",
        "inWindowEvents": 1945,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.1"
      },
      {
        "studentId": "HE200736",
        "hasLoggedIn": true,
        "trueSignin": 1790210355412,
        "trueExpire": 1790217351000,
        "tokensConsumed": 23893,
        "promptCount": 8,
        "latestClassification": "mixed",
        "inWindowEvents": 2339,
        "preSessionFiltered": 112,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE200785",
        "hasLoggedIn": true,
        "trueSignin": 1790212218000,
        "trueExpire": 1790216828000,
        "tokensConsumed": 76208,
        "promptCount": 15,
        "latestClassification": "mixed",
        "inWindowEvents": 384,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE200854",
        "hasLoggedIn": true,
        "trueSignin": 1790211341942,
        "trueExpire": 1790216469000,
        "tokensConsumed": 79251,
        "promptCount": 10,
        "latestClassification": "mixed",
        "inWindowEvents": 773,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "104.28.211.59"
      },
      {
        "studentId": "HE201042",
        "hasLoggedIn": true,
        "trueSignin": 1790211386000,
        "trueExpire": 1790216861000,
        "tokensConsumed": 108953,
        "promptCount": 21,
        "latestClassification": "mixed",
        "inWindowEvents": 1256,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.12"
      },
      {
        "studentId": "HE201163",
        "hasLoggedIn": true,
        "trueSignin": 1790211408000,
        "trueExpire": 1790216789000,
        "tokensConsumed": 35336,
        "promptCount": 6,
        "latestClassification": "mixed",
        "inWindowEvents": 1123,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.230"
      },
      {
        "studentId": "HE201200",
        "hasLoggedIn": true,
        "trueSignin": 1790210712962,
        "trueExpire": 1790216777000,
        "tokensConsumed": 43985,
        "promptCount": 9,
        "latestClassification": "mixed",
        "inWindowEvents": 1210,
        "preSessionFiltered": 187,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.4"
      },
      {
        "studentId": "HE201256",
        "hasLoggedIn": true,
        "trueSignin": 1790210604295,
        "trueExpire": 1790216776000,
        "tokensConsumed": 52236,
        "promptCount": 14,
        "latestClassification": "mixed",
        "inWindowEvents": 2102,
        "preSessionFiltered": 321,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.228"
      },
      {
        "studentId": "HE201724",
        "hasLoggedIn": true,
        "trueSignin": 1790211480864,
        "trueExpire": 1790216801000,
        "tokensConsumed": 0,
        "promptCount": 0,
        "latestClassification": "none",
        "inWindowEvents": 852,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.234"
      },
      {
        "studentId": "HE204083",
        "hasLoggedIn": true,
        "trueSignin": 1790210754555,
        "trueExpire": 1790217080000,
        "tokensConsumed": 19677,
        "promptCount": 5,
        "latestClassification": "mixed",
        "inWindowEvents": 1688,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "58.186.240.5"
      },
      {
        "studentId": "HE204089",
        "hasLoggedIn": true,
        "trueSignin": 1790210536571,
        "trueExpire": 1790216790000,
        "tokensConsumed": 78892,
        "promptCount": 17,
        "latestClassification": "mixed",
        "inWindowEvents": 2506,
        "preSessionFiltered": 710,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.226"
      },
      {
        "studentId": "HE204798",
        "hasLoggedIn": true,
        "trueSignin": 1790211849000,
        "trueExpire": 1790216797000,
        "tokensConsumed": 18980,
        "promptCount": 5,
        "latestClassification": "mixed",
        "inWindowEvents": 33,
        "preSessionFiltered": 0,
        "postSessionFiltered": 0,
        "uploadIp": "118.70.211.228"
      }
    ]
  }
};
