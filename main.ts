import { cac, config, DB } from './deps.ts';

const cli = cac('omhh');

type FdcIdQueryParam = { fdcId: string };

type FoodQueryTuple = [number, string, string];
// deno-lint-ignore camelcase
type FoodQueryEntry = { fdc_id: number, description: string, source: string };

type NutrientsQueryTuple = [string, number, string];
// deno-lint-ignore camelcase
type NutrientsQueryEntry = { name: string, amount: number, unit_name: string };

type BrandQueryTuple = [string, string, string, number, string, string];
// deno-lint-ignore camelcase
type BrandQueryEntry = { brand_owner?: string, brand_name?: string, subbrand_name?: string, serving_size?: number, serving_size_unit?: string, household_serving_fulltext?: string };

type PortionsQueryTuple = [number, string, number, string, string];
// deno-lint-ignore camelcase
type PortionsQueryEntry = { amount: number, unit: string, gram_weight: number, portion_description: string, modifier: string };


interface UpOptions {
    db: string;
    api: string;
    token: string;
    file: string;
}

cli.command('add [...fdcIds]>', 'adds (or overwrites) foods to Oh My Heart and Home database')
    .option('--db', 'source sqlite3 database file path', { default: './food-data.sqlite3' })
    .option('--api', 'omhh api uri')
    .option('--token', 'omhh api token')
    .option('--file <file>', 'file of fdc ids')
    .action(async (fdcIds: string[] = [], options: UpOptions) => {
        if (fdcIds[fdcIds.length - 1] === 'main.ts') {
            fdcIds.pop();
        }

        config({ safe: false, export: true });
        const { OMHH_API_URI, OMHH_API_TOKEN } = Deno.env.toObject();

        const {
            db: dbFilePath,
            api: apiBase = OMHH_API_URI,
            token = OMHH_API_TOKEN,
            file,
        } = options;

        // get a resolved list of fdc-ids to check
        let portionMap: Record<string, PortionsQueryEntry[]> = {};
        if (file != null) {
            const text = await Deno.readTextFile(file);

            // quick and dirty parsing of csv file.  The csv is setup as:
            //
            // <fdc_id>,<gram_weight>,<unit>,<modifier>\n
            //
            // all amounts are assumed to be 1

            // split the rows
            portionMap = text.split('\n')
                // split the columns and trim any whitespace
                .map(rowStr => rowStr.split(',').map(v => v.trim()))

                // parse the columns
                .map(([fdc_id, gram_weight, unit, modifier]) => ({
                    fdc_id,
                    gram_weight: parseFloat(gram_weight),
                    unit,
                    modifier
                }))

                // combine portions of the same fdc_id and map the columns into a PortionsQueryEntry
                .reduce((pMap, f) => {
                    // deno-lint-ignore camelcase
                    const { fdc_id, gram_weight, unit, modifier } = f;
                    const portion: PortionsQueryEntry & { _key: string } = {
                        _key: `1${unit}${modifier}`,
                        amount: 1,
                        unit,
                        // deno-lint-ignore camelcase
                        gram_weight,
                        modifier,
                        // deno-lint-ignore camelcase
                        portion_description: ''
                    };

                    if (fdc_id in pMap) {
                        pMap[fdc_id].push(portion);
                    } else {
                        pMap[fdc_id] = [portion];
                    }

                    return pMap;
                }, portionMap);
        }

        // if a file was provided then extract the unique fdc_ids for lookup
        const keysFromFile = Object.keys(portionMap);
        if (keysFromFile.length > 0) {
            fdcIds.push(...keysFromFile);
        }

        // for each new id, look them up in the database and construct the mutation
        const db = new DB(dbFilePath, { mode: 'read' });
        // deno-lint-ignore camelcase
        let fdc_id: number | undefined = undefined;
        let description: string | undefined = undefined;
        let source: string | undefined = undefined;
        // deno-lint-ignore no-explicit-any
        let mutation: { mutations: any[] } | undefined = undefined;
        try {
            const foodQuery = db.prepareQuery<FoodQueryTuple, FoodQueryEntry, FdcIdQueryParam>(`
                select f.fdc_id, f.description, f.data_type as source
                from food f where f.fdc_id = :fdcId
            `.trim());

            const nutrientsQuery = db.prepareQuery<NutrientsQueryTuple, NutrientsQueryEntry, FdcIdQueryParam>(`
                select n.name, fn.amount, n.unit_name from food_nutrient fn
                inner join nutrient n on fn.nutrient_id = n.id
                where fn.fdc_id = :fdcId
            `.trim());

            const brandQuery = db.prepareQuery<BrandQueryTuple, BrandQueryEntry, FdcIdQueryParam>(`
                select brand_owner, ifnull(brand_name,'') as brand_name, ifnull(subbrand_name,'') as subbrand_name, ifnull(serving_size,0) as serving_size, ifnull(serving_size_unit,'') as serving_size_unit, ifnull(household_serving_fulltext,'') as household_serving_fulltext from branded_food
                where fdc_id = :fdcId
            `.trim());

            const portionsQuery = db.prepareQuery<PortionsQueryTuple, PortionsQueryEntry, FdcIdQueryParam>(`
                select fp.amount, m.name as unit, fp.gram_weight, ifnull(fp.portion_description,'') as portion_description, ifnull(fp.modifier,'') as modifier from food_portion fp
                inner join measure_unit m on fp.measure_unit_id = m.id
                where fp.fdc_id = :fdcId
            `.trim());

            const mutations = fdcIds.map((fdcId, i) => {
                console.log(`processing ${i + 1} of ${fdcIds.length}`);
                try {
                    const food: FoodQueryEntry = foodQuery.oneEntry({ fdcId });
                    fdc_id = food.fdc_id;
                    description = food.description;
                    source = food.source;
                } catch (_error) {
                    console.error(`could not find fdc_id: ${fdcId}`);
                }

                let brand: BrandQueryEntry = {}
                try {
                    brand = brandQuery.oneEntry({ fdcId });
                } catch (_error) {
                    // ignore
                }

                const nutrients: NutrientsQueryEntry[] = [];
                try {
                    nutrients.push(...nutrientsQuery.allEntries({ fdcId }).map(n => ({ _key: n, ...n })).sort((a, b) => {
                        if (a.name === b.name) {
                            return 0;
                        } else if (a.name > b.name) {
                            return 1;
                        } else {
                            return -1;
                        }
                    }));
                } catch (_error) {
                    // ignore
                }

                const portions: PortionsQueryEntry[] = [];
                if (fdcId in portionMap) {
                    portions.push(...portionMap[fdcId]);
                }
                try {
                    portions.push(...portionsQuery.allEntries({ fdcId }).map(p => ({ _key: `${p.amount}${p.unit}${p.modifier}`, ...p })).sort((a, b) => {
                        if (a.unit === b.unit) {
                            return 0;
                        } else if (a.unit < b.unit) {
                            return 1;
                        } else {
                            return -1;
                        }
                    }));
                } catch (_error) {
                    // ignore
                }

                // deno-lint-ignore camelcase
                const { brand_owner, brand_name, subbrand_name, serving_size, serving_size_unit, household_serving_fulltext } = brand;
                const doc = {
                    createOrReplace: {
                        _id: fdcId,
                        _type: 'food',
                        description,
                        fdc_id,
                        source,
                        nutrients,
                        portions,
                        brand_owner,
                        brand_name,
                        subbrand_name,
                        serving_size,
                        serving_size_unit,
                        household_serving_fulltext,
                    }
                };

                fdc_id = undefined;
                description = undefined;
                source = undefined;

                return doc;
            }).filter(data => {
                if (data.createOrReplace.fdc_id) {
                    return true;
                }
                return false;
            });

            mutation = { mutations }
        } catch (error) {
            return console.error(error);
        } finally {
            db.close(true);
            console.log('processing complete.');
        }

        // post mutation
        if (mutation) {
            console.log('Uploading documents, this may take a minute...');
            const postApi = `${apiBase[apiBase.length - 1] == '/' ? apiBase.slice(0, apiBase.length - 1) : apiBase}/data/mutate/production`;
            try {
                const res = await fetch(
                    postApi,
                    {
                        method: 'post',
                        headers: {
                            'Content-type': 'application/json',
                            Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify(mutation)
                    }
                );
                const result = await res.json();
                console.log(`Uploaded ${mutation.mutations.length} foods`);
                console.log(result);
            } catch (error) {
                console.error(error);
            }
        }
    });

cli.help();
cli.version('1.0.0');
cli.parse();