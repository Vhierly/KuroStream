window.MockData = {
  featured: {
    title: "Solo Leveling: Arise from Shadow",
    subtitle: "When the weakest hunter awakens, every gate becomes a battlefield.",
    genres: ["Action", "Fantasy", "Shounen"],
    rating: 8.9,
    year: 2024
  },
  animes: [
    {id:1,title:"Jujutsu Kaisen",genre:"Action",rating:8.7,year:2023,eps:47,status:"ongoing"},
    {id:2,title:"Frieren: Beyond Journey's End",genre:"Adventure",rating:9.1,year:2024,eps:28,status:"completed"},
    {id:3,title:"Demon Slayer",genre:"Action",rating:8.6,year:2024,eps:55,status:"ongoing"},
    {id:4,title:"One Piece",genre:"Adventure",rating:9.0,year:2026,eps:1110,status:"ongoing"},
    {id:5,title:"Kaiju No. 8",genre:"Sci-Fi",rating:8.3,year:2024,eps:12,status:"ongoing"},
    {id:6,title:"Oshi no Ko",genre:"Drama",rating:8.5,year:2024,eps:24,status:"ongoing"},
    {id:7,title:"Blue Lock",genre:"Sports",rating:8.2,year:2023,eps:24,status:"completed"},
    {id:8,title:"Attack on Titan",genre:"Action",rating:9.0,year:2023,eps:89,status:"completed"},
    {id:9,title:"Chainsaw Man",genre:"Action",rating:8.4,year:2022,eps:12,status:"ongoing"},
    {id:10,title:"Bocchi the Rock!",genre:"Comedy",rating:8.6,year:2022,eps:12,status:"completed"}
  ],
  latestEpisodes:[
    {anime:"Jujutsu Kaisen",ep:"S2 E23",time:"2h ago"},
    {anime:"One Piece",ep:"E1110",time:"5h ago"},
    {anime:"Kaiju No. 8",ep:"E12",time:"8h ago"},
    {anime:"Oshi no Ko",ep:"S2 E11",time:"1d ago"}
  ],
  continueWatching:[
    {id:2,title:"Frieren",ep:21,progress:76},
    {id:4,title:"One Piece",ep:1088,progress:35},
    {id:9,title:"Chainsaw Man",ep:7,progress:59}
  ],
  episodes: Array.from({length:12}, (_,i)=>({num:i+1,title:`Episode ${i+1}: Rising Conflict`,duration:`${23+i%2} min`})),
};