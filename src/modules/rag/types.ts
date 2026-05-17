export type Citation = {
	sourceId: string;
	fragmentId: string;
	uri: string;
	title: string;
	heading?: string;
	locator: string;
	score: number;
};

export type RetrievedFragment = {
	id: string;
	sourceId: string;
	sourceUri: string;
	locator: string;
	heading: string | null;
	content: string;
	vectorScore?: number;
	textScore?: number;
	trigramScore?: number;
	combinedScore: number;
};
