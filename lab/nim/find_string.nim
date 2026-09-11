type ByteArray = UncheckedArray[uint8]

const
  LabOk = 0.cint
  LabNotFound = 1.cint
  LabInvalidJson = 2.cint
  LabBadArgument = 4.cint

proc isWs(c: uint8): bool {.inline.} =
  c == 32'u8 or c == 9'u8 or c == 10'u8 or c == 13'u8

proc isHex(c: uint8): bool {.inline.} =
  (c >= 48'u8 and c <= 57'u8) or
  (c >= 65'u8 and c <= 70'u8) or
  (c >= 97'u8 and c <= 102'u8)

proc boundary(json: ptr ByteArray; n, pos: int): bool {.inline.} =
  if pos >= n:
    return true
  let c = json[pos]
  isWs(c) or c == 44'u8 or c == 93'u8 or c == 125'u8

proc quoteIsEscaped(json: ptr ByteArray; pos0: int): bool {.inline.} =
  var pos = pos0
  var count = 0
  while pos > 0:
    dec pos
    if json[pos] != 92'u8:
      break
    inc count
  (count and 1) != 0

proc skipWs(json: ptr ByteArray; n, pos0: int): int {.inline.} =
  var pos = pos0
  while pos < n and isWs(json[pos]):
    inc pos
  pos

proc parseString(json: ptr ByteArray; n, pos0: int;
                 valueOffset, valueLen: ptr csize_t): cint =
  var pos = skipWs(json, n, pos0)
  if pos >= n or json[pos] != 34'u8:
    return LabInvalidJson

  inc pos
  let start = pos
  while pos < n:
    let c = json[pos]
    if c == 92'u8:
      inc pos
      if pos >= n:
        return LabInvalidJson
      let esc = json[pos]
      if esc == 117'u8:
        if pos + 4 >= n or
           not isHex(json[pos + 1]) or not isHex(json[pos + 2]) or
           not isHex(json[pos + 3]) or not isHex(json[pos + 4]):
          return LabInvalidJson
        pos += 5
        continue
      if not (esc == 34'u8 or esc == 92'u8 or esc == 47'u8 or
              esc == 98'u8 or esc == 102'u8 or esc == 110'u8 or
              esc == 114'u8 or esc == 116'u8):
        return LabInvalidJson
      inc pos
      continue

    if c == 34'u8:
      if not boundary(json, n, pos + 1):
        return LabInvalidJson
      valueOffset[] = csize_t(start)
      valueLen[] = csize_t(pos - start)
      return LabOk

    if c < 32'u8:
      return LabInvalidJson
    inc pos

  LabInvalidJson

proc nim_lab_find_string(json: cstring; jsonLen: csize_t;
                         key: cstring; keyLen: csize_t;
                         valueOffset, valueLen: ptr csize_t): cint
                         {.cdecl, exportc.} =
  if json == nil or key == nil or valueOffset == nil or valueLen == nil:
    return LabBadArgument

  if uint64(jsonLen) > uint64(high(int)) or uint64(keyLen) > uint64(high(int)):
    return LabBadArgument

  let n = int(jsonLen)
  let kn = int(keyLen)
  if kn + 2 > n:
    return LabNotFound

  let bytes = cast[ptr ByteArray](json)
  let keyBytes = cast[ptr ByteArray](key)
  var i = 0
  while i + kn + 2 <= n:
    if bytes[i] != 34'u8 or quoteIsEscaped(bytes, i):
      inc i
      continue

    var k = 0
    while k < kn and bytes[i + 1 + k] == keyBytes[k]:
      inc k

    if k == kn and bytes[i + 1 + kn] == 34'u8:
      let after = skipWs(bytes, n, i + kn + 2)
      if after < n and bytes[after] == 58'u8:
        return parseString(bytes, n, after + 1, valueOffset, valueLen)
    inc i

  LabNotFound
