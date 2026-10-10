import { DATA_LABEL, PARTY_LABEL, PRIVACY_DATA, PRIVACY_PARTIES, type ExecutionDisclosure, type Exposure } from "@/core/privacy";
import { cn } from "@/lib/utils";
import { EXPOSURE_LABEL } from "./mode-labels";

const EXPOSURE_STYLE: Record<Exposure, string> = {
  visible: "bg-sell/15 text-sell",
  partial: "bg-warning/15 text-warning",
  "not-visible": "bg-buy/15 text-buy",
  "not-applicable": "bg-muted text-muted-foreground",
};

/**
 * Who can see what, for one mode on one venue. Rendered straight from the
 * venue's declared privacy profile, so it cannot claim more than the venue does.
 */
export function PrivacyMatrix({ disclosure }: { disclosure: ExecutionDisclosure }) {
  const profile = disclosure.profile;
  if (!profile) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-xs" data-testid="privacy-matrix" data-mode={disclosure.mode}>
        <caption className="sr-only">
          Who can see what for a {disclosure.mode} order on {disclosure.venueName}
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-1.5 pr-2 font-medium">
              Party
            </th>
            {PRIVACY_DATA.map((data) => (
              <th key={data} scope="col" className="px-2 py-1.5 font-medium">
                {DATA_LABEL[data]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PRIVACY_PARTIES.map((party) => (
            <tr key={party} className="border-b align-top last:border-0" data-party={party}>
              <th scope="row" className="py-2 pr-2 text-left font-medium whitespace-nowrap">
                {PARTY_LABEL[party]}
              </th>
              {PRIVACY_DATA.map((data) => {
                const cell = profile[party][data];
                return (
                  <td key={data} className="px-2 py-2" data-testid={`privacy-${party}-${data}`} data-exposure={cell.exposure}>
                    <span className={cn("inline-block rounded px-1.5 py-0.5 text-2xs font-semibold", EXPOSURE_STYLE[cell.exposure])}>
                      {EXPOSURE_LABEL[cell.exposure]}
                    </span>
                    {cell.note && <p className="mt-1 text-2xs leading-snug text-muted-foreground">{cell.note}</p>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
