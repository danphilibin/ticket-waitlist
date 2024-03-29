import z from 'zod';
import { sendPushAlert } from '../alerts';

/**
 * Configure these values to your liking.
 */

// Get the event ID from the end of the URL. Example:
// https://gametime.co/nba-basketball/bucks-at-clippers-tickets/3-10-2024-los-angeles-ca-crypto-com-arena/events/64de74ca2d4ca900013dffc6

const PLATFORM_NAME = 'Gametime';
const EVENT_ID = '64de74ca2d4ca900013dffc6';
const EVENT_NAME = 'Lakers vs. Suns';
const SEATS_TOGETHER = 2;
const MAX_ALL_IN_PRICE_PER_SEAT = 350;
const SECTIONS_REGEX = [/^PR/, /^1/];
const SECTION_GROUP_NAMES = [/^Premier/, /^Loge/, /^Baseline/];
const MAX_RETURN_LIST = 10;

// wait until getting this many consecutive errors before creating an error state
const MIN_ERROR_COUNT = 4;

// Don't send more than one text every const TEXT_MAX_FREQUENCY_MINS mins.
const TEXT_MAX_FREQUENCY_MINS = 15;

/**
 * You probably don't need to change anything below this line.
 */

const pricesSeen: number[] = [];

const listingObj = z.object({
  // delivery_type: z.string(),
  // transfer_type: z.string(),
  price: z.object({
    face_value: z.number().nullable(),
    prefee: z.number(),
    total: z.number(),
    sales_tax: z.number(),
  }),
  // disclosures: z.array(z.any()),
  lots: z.array(z.number()), // number(s) that can be sold together
  seats: z.array(z.string()), // array of asterisks
  // event_id: z.string(),
  id: z.string(),
  row: z.string(),
  section: z.string(),
  section_group: z.string(), // e.g. "Premier"
});

type Listing = z.infer<typeof listingObj>;

export const outputSchema = z.object({
  // groups by section etc, not important
  display_groups: z.array(z.any()),
  listings: z.record(z.string(), listingObj),
});

let AVAILABLE_SEATS: Listing[] = [];
let LAST_TEXT_SENT_AT = 0;
let ERROR_COUNT = 0;
let ERROR = false;
let STATUS_MESSAGE = 'NO_SEATS';

export function getStatusMessage() {
  return ERROR ? 'ERROR' : STATUS_MESSAGE;
}

function calculateTotalPrice(listing: Listing) {
  const allIn =
    listing.price.prefee + listing.price.total + listing.price.sales_tax;
  return allIn / 100;
}

const fmtPrice = (price: number) =>
  price.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

// idk how much of this URL is necessary and whether any of it changes the results, I copied it from the network tab
// most of these seem like analytics stuff, a few probably opt you into certain tests
// (e.g. zone_deals_true_v4, cost_plus_v0, control_v1)
const fullUrl = `https://mobile.gametime.co/v2/listings/${EVENT_ID}?zListings04=min_shsg_v2&zListings09=2&zListings11=linear_regression_model_v0_breakpoint_20&zListings18=show_vaccine_required_listings_true&zListings19=zoom_zoom_v0&zListings20=control&zListings30=jenks&zListings31=control&zListings32=control_v1&zListings39=seatvec_v0&zListings40=sr1_v3&zListings42=19_favor&zListings43=5_v0&zListings44=fg_v0_3&zListings45=zbp_v1&zListings47=a_34_v1&zListings48=cost_plus_v0&zListings50=zone_deals_true_v4&sort_order=low_to_high&all_in_pricing=false&zoom=9`;

export async function check() {
  AVAILABLE_SEATS = [];
  STATUS_MESSAGE = 'NO_SEATS';
  ERROR = false;

  const response = await fetch(fullUrl).then((res) => res.json());

  try {
    const res = outputSchema.safeParse(response);

    if (!res.success) {
      console.log('error parsing response');
      console.log(res.error);
      return;
    }

    const data = res.data;

    AVAILABLE_SEATS = Object.values(data.listings)
      .filter((l) => {
        // must have at least SEATS_TOGETHER seats
        if (l.seats.length < SEATS_TOGETHER) return false;

        // SEATS_TOGETHER seats must be in the same lot
        if (!l.lots.includes(SEATS_TOGETHER)) return false;

        // must be in a section that matches SECTIONS_REGEX or SECTION_GROUP_NAMES
        if (
          !SECTIONS_REGEX.some((r) => r.test(l.section)) &&
          !SECTION_GROUP_NAMES.some((r) => r.test(l.section_group))
        ) {
          return false;
        }

        // all-in price per seat must be less than MAX_ALL_IN_PRICE_PER_SEAT
        if (calculateTotalPrice(l) > MAX_ALL_IN_PRICE_PER_SEAT) return false;

        return true;
      })
      .sort((a, b) => {
        const aPrice = calculateTotalPrice(a);
        const bPrice = calculateTotalPrice(b);
        return aPrice - bPrice;
      })
      .slice(0, MAX_RETURN_LIST);
  } catch (error) {
    console.error(error);

    ERROR_COUNT++;

    if (ERROR_COUNT >= MIN_ERROR_COUNT) {
      ERROR = true;
      return;
    }
  }

  ERROR_COUNT = 0;

  if (!AVAILABLE_SEATS.length) {
    console.log('No seats found.');
    return;
  }

  const readout = AVAILABLE_SEATS.map((l) => {
    const allInEach = calculateTotalPrice(l);
    const total = allInEach * SEATS_TOGETHER;

    const formattedEach = fmtPrice(allInEach);
    const formattedTotal = fmtPrice(total);

    return `- Sec ${l.section} Row ${l.row}, ${formattedEach} each (${formattedTotal} total)`;
  });

  STATUS_MESSAGE = `🏀 Seats available for ${EVENT_NAME}!\n`;
  STATUS_MESSAGE += `(checking ${PLATFORM_NAME} for ${SEATS_TOGETHER} seats together at ${fmtPrice(
    MAX_ALL_IN_PRICE_PER_SEAT
  )} each in sections similar to ${SECTION_GROUP_NAMES.join(', ')})`;

  const lowestPrice = calculateTotalPrice(AVAILABLE_SEATS[0]);

  if (!pricesSeen.length) {
    pricesSeen.push(lowestPrice);
  } else {
    const lowestPriceSeen = Math.min(...pricesSeen);
    const lastPriceSeen = pricesSeen[pricesSeen.length - 1];

    pricesSeen.push(lowestPrice);

    if (lowestPrice < lowestPriceSeen) {
      STATUS_MESSAGE += `\n\n⭐ New lowest price on ${PLATFORM_NAME}: ${fmtPrice(
        lowestPrice
      )}\n`;
    } else if (lowestPrice < lastPriceSeen) {
      console.log(
        `🔻 ${PLATFORM_NAME} price decreased to ${fmtPrice(lowestPrice)}`
      );
      return;
    } else if (lowestPrice > lastPriceSeen) {
      console.log(
        `🔺 ${PLATFORM_NAME} price increased to ${fmtPrice(lowestPrice)}`
      );
      return;
    } else {
      console.log(
        `🔄 ${PLATFORM_NAME} Price unchanged at ${fmtPrice(lowestPrice)}`
      );
      return;
    }
  }

  for (const line of readout) {
    STATUS_MESSAGE += `\n${line}`;
  }

  // Don't send a text if one was sent in the last 30 minutes
  if (Date.now() - LAST_TEXT_SENT_AT < TEXT_MAX_FREQUENCY_MINS * 60 * 1000) {
    console.log(
      `Text already sent within the last ${TEXT_MAX_FREQUENCY_MINS} minutes.`
    );
    return;
  }

  LAST_TEXT_SENT_AT = Date.now();

  await sendPushAlert({
    mode: 'pushover',
    message: STATUS_MESSAGE,
  });
}
