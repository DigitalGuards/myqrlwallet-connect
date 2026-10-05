"""Independent reference for the QRL-SIGN-TYPED-v1/v2 typed-data digests.

Written from the scheme definition in docs/JSON-RPC-REFERENCE.md, with no
code shared with src/signing/typedData.ts. It recomputes every entry of
canonical.json's schemeVectors and schemeSigningVectors and exits non-zero
on any mismatch:

    python3 scripts/typed-data-reference.py src/signing/__fixtures__/canonical.json

Run it whenever the fixtures are regenerated.
"""
import hashlib, json, re, sys

def shake(b): return hashlib.shake_256(b).digest(64)

def deps(primary, types, acc=None):
    acc = acc if acc is not None else []
    if primary in acc: return acc
    acc.append(primary)
    for f in types[primary]:
        base = re.sub(r'(\[\d*\])+$', '', f['type'])
        if base in types: deps(base, types, acc)
    return acc

def encode_type(primary, types):
    d = deps(primary, types)
    order = [primary] + sorted(x for x in d if x != primary)
    return ''.join(f"{n}({','.join(f['type']+' '+f['name'] for f in types[n])})" for n in order)

def type_hash(primary, types): return shake(encode_type(primary, types).encode())

def to_int(v): 
    if isinstance(v, bool): raise ValueError
    if isinstance(v, int): return v
    s = str(v)
    neg = s.startswith('-'); s = s[1:] if neg else s
    n = int(s, 16) if s.lower().startswith('0x') else int(s)
    return -n if neg else n

def enc(typ, val, types, slot):
    m = re.match(r'^(.+?)\[(\d*)\]$', typ)
    if m:  # arrays (outermost dimension last in the string; recursive on the inner type)
        inner = typ[:typ.rindex('[')]
        return shake(b''.join(enc(inner, x, types, slot) for x in val))
    if typ in types: return hash_struct(typ, val, types, slot)
    if typ == 'address':
        b = bytes.fromhex(val[1:]); assert len(b) <= slot
        return b.rjust(slot, b'\0')
    if typ == 'bool': return bytes([1 if val else 0]).rjust(slot, b'\0')
    if typ == 'string': return shake(val.encode())
    if typ == 'bytes': return shake(bytes.fromhex(val[2:]))
    mi = re.match(r'^(u?)int(\d+)$', typ)
    if mi:
        n = to_int(val); bits = slot * 8
        return (n % (1 << bits)).to_bytes(slot, 'big')
    mb = re.match(r'^bytes(\d+)$', typ)
    if mb:
        b = bytes.fromhex(val[2:]); assert len(b) == int(mb.group(1))
        return b.ljust(slot, b'\0')
    raise ValueError(typ)

def hash_struct(name, data, types, slot):
    return shake(type_hash(name, types) + b''.join(enc(f['type'], data[f['name']], types, slot) for f in types[name]))

def scheme(payload):
    t = payload['types']
    for root in ('QRLDomain', payload['primaryType']):
        for n in deps(root, t):
            if any(re.sub(r'(\[\d*\])+$', '', f['type']) == 'address' for f in t[n]): return 'QRL-SIGN-TYPED-v2'
    return 'QRL-SIGN-TYPED-v1'

def digest(payload):
    s = scheme(payload); slot = 64 if s.endswith('v2') else 32; t = payload['types']
    dh = hash_struct('QRLDomain', payload['domain'], t, slot)
    mh = hash_struct(payload['primaryType'], payload['message'], t, slot)
    return s, dh, mh, shake(s.encode() + dh + mh)

d = json.load(open(sys.argv[1]))
ok = True
for v in d['schemeVectors']:
    s, dh, mh, dg = digest(v['payload'])
    checks = [s == v['schemeVersion'], '0x'+dh.hex() == v['domainHashHex'], '0x'+mh.hex() == v['messageHashHex'], '0x'+dg.hex() == v['digestHex'], encode_type(v['payload']['primaryType'], v['payload']['types']) == v['encodeTypeString']]
    print('OK ' if all(checks) else 'BAD', v['label'], checks); ok &= all(checks)
for v in d['schemeSigningVectors']:
    s, _, _, dg = digest(v['payload'])
    c = ['0x'+dg.hex() == v['digest'], s == v['schemeVersion']]
    print('OK ' if all(c) else 'BAD', v['label'], c); ok &= all(c)
sys.exit(0 if ok else 1)
