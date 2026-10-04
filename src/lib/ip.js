const net = require('node:net');

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The 8 groups of an IPv6 address as numbers (`::` and a trailing dotted IPv4 expanded), or null. */
function ipv6Groups(address) {
  let text = address.split('%')[0].toLowerCase(); // drop a zone id such as %eth0
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...headGroups, ...Array(tail === undefined ? 0 : missing).fill('0'), ...tailGroups];
  const numbers = groups.map((group) => parseInt(group, 16));
  return groups.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? numbers : null;
}

/**
 * What to rate-limit a client by: its IPv4 address, or for IPv6 its /64 prefix.
 * One household or phone is handed a whole /64, and anyone in it can switch
 * addresses at will, so counting single IPv6 addresses would let a client dodge
 * its limit. IPv4-mapped IPv6 addresses (::ffff:1.2.3.4) count as that IPv4.
 * @param {string | undefined} ip an address as reported by Express (`req.ip`)
 * @returns {string | undefined}
 */
function ipBucket(ip) {
  if (typeof ip !== 'string' || ip === '') return undefined;
  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped) return mapped[1];
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip.split('%')[0])) return ip; // not an address we understand: count it as is
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

module.exports = { ipBucket };
